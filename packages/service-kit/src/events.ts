import { Injectable, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import type { PoolClient } from 'pg';
import { eventConsumerSubscriptions, platformEventSchema, type PlatformEvent } from '@palladium/contracts';
import { Database } from './database.js';
import { OPTIONS, type ServiceOptions } from './auth.js';
import { currentCloudflareBindings, isCloudflareRuntime } from './runtime.js';
import { decodeQueueEvent, encodeQueueEvent, type QueueEvent } from './event-transport.js';
const exchange = 'palladium.events';
export async function emitEvent(tx: PoolClient, input: {type:string;producer:string;businessId:string;correlationId?:string;data:Record<string,unknown>}): Promise<string> {
  const event = platformEventSchema.parse({...input,id:randomUUID(),version:1,occurredAt:new Date().toISOString(),correlationId:input.correlationId ?? randomUUID()});
  if (event.producer !== event.type.split('.')[0]) throw new Error('Invalid event producer');
  await tx.query('INSERT INTO service_outbox(id,event) VALUES($1,$2)',[event.id,JSON.stringify(event)]);
  return event.id;
}
type Handler = (event:PlatformEvent, tx:PoolClient)=>Promise<void>;
@Injectable()
export class EventBus {
  private handlers = new Map<string,Handler[]>();
  private connection?: ChannelModel;
  private channel?: ConfirmChannel;
  private interval?: ReturnType<typeof setInterval>;
  private reconnect?: ReturnType<typeof setTimeout>;
  private busy = false;
  private lastPrune = 0;
  private stopping = false;
  private starting = false;
  connected = false;
  constructor(@Inject(Database) private readonly db:Database,@Inject(OPTIONS) private readonly options:ServiceOptions) {}
  subscribe(type:string,handler:Handler) { this.handlers.set(type,[...(this.handlers.get(type) ?? []),handler]); }
  async start() {
    if (isCloudflareRuntime()) { this.connected = true; return; }
    if (process.env.DISABLE_BROKER === 'true' || this.stopping || this.starting || this.connected) return;
    if (!process.env.RABBITMQ_URL) throw new Error('RABBITMQ_URL is required');
    this.starting = true;
    let connection: ChannelModel | undefined;
    try {
      const conn = await amqp.connect(process.env.RABBITMQ_URL);
      connection = conn;
      if (this.stopping) { await conn.close().catch(()=>{}); return; }
      this.connection = conn;
      conn.on('error',()=>this.disconnect(conn));
      conn.on('close',()=>this.disconnect(conn));
      const channel = await conn.createConfirmChannel();
      if (this.connection !== conn || this.stopping) { await conn.close().catch(()=>{}); return; }
      this.channel = channel;
      channel.on('error',()=>this.disconnect(conn));
      channel.on('close',()=>this.disconnect(conn));
      await channel.assertExchange(exchange,'topic',{durable:true});
      // Confirmed exchange publication only guarantees retention when a queue is
      // already bound. Declare every known destination before enabling flush.
      const destinations = new Map<string,Set<string>>();
      for (const subscription of eventConsumerSubscriptions) {
        destinations.set(subscription.consumer,new Set(subscription.types));
      }
      if (this.handlers.size) {
        const own = destinations.get(this.options.name) ?? new Set<string>();
        for (const type of this.handlers.keys()) own.add(type);
        destinations.set(this.options.name,own);
      }
      for (const [consumer,types] of destinations) {
        const queue=`palladium.${consumer}`;
        await channel.assertQueue(queue,{durable:true});
        await channel.assertQueue(`${queue}.dead`,{durable:true});
        await channel.assertQueue(`${queue}.retry`,{durable:true,arguments:{'x-message-ttl':5000,'x-dead-letter-exchange':'','x-dead-letter-routing-key':queue}});
        for (const type of types) await channel.bindQueue(queue,exchange,type);
      }
      if (this.handlers.size) {
        const queue=`palladium.${this.options.name}`;
        await channel.prefetch(10);
        await channel.consume(queue,msg=>{if(msg) void this.consume(channel,queue,msg);},{noAck:false});
      }
      if (this.connection !== conn || this.channel !== channel || this.stopping) throw new Error('Event transport closed during setup');
      this.connected=true;
      if (!this.interval) this.interval=setInterval(()=> {
        void this.flush();
        if (Date.now() - this.lastPrune > 60 * 60 * 1000) {
          this.lastPrune = Date.now();
          void this.prunePublishedOutbox().catch(() => { /* Retry next hour. */ });
        }
      },300);
      console.log(`[${this.options.name}] event transport connected`);
    } catch {
      if (this.connection === connection) { this.connected=false; this.channel=undefined; this.connection=undefined; }
      if (connection) void connection.close().catch(()=>{});
      if (!this.stopping) console.warn(`[${this.options.name}] event transport unavailable; retrying`);
    } finally {
      this.starting=false;
      if (!this.connected) this.scheduleReconnect();
    }
  }
  private disconnect(connection:ChannelModel) {
    // A late close/error from an old connection must not invalidate its replacement.
    if (this.connection !== connection) return;
    this.connected=false;
    this.channel=undefined;
    this.connection=undefined;
    void connection.close().catch(()=>{});
    this.scheduleReconnect();
  }
  private scheduleReconnect() {
    if(this.stopping || this.starting || this.reconnect)return;
    this.reconnect=setTimeout(()=>{this.reconnect=undefined;void this.start();},3000);
  }
  private async send(channel:ConfirmChannel,queue:string,msg:ConsumeMessage,attempts:number) {
    await new Promise<void>((resolve,reject)=>channel.sendToQueue(queue,msg.content,{persistent:true,contentType:'application/json',headers:{...msg.properties.headers,'x-attempts':attempts}},err=>err?reject(err):resolve()));
  }
  private async consume(channel:ConfirmChannel,queue:string,msg:ConsumeMessage) {
    try {
      await this.consumeEvent(JSON.parse(msg.content.toString()));
      channel.ack(msg);
    } catch {
      const attempts=Number(msg.properties.headers?.['x-attempts']??0)+1;
      try { await this.send(channel,attempts>=5?`${queue}.dead`:`${queue}.retry`,msg,attempts);channel.ack(msg); }
      catch { try { channel.nack(msg,false,true); } catch {} }
    }
  }
  async consumeEvent(input: unknown): Promise<void> {
    const event = isCloudflareRuntime() ? await decodeQueueEvent(input) : platformEventSchema.parse(input);
    if (event.producer !== event.type.split('.')[0]) throw new Error('Invalid event producer');
    const handlers = this.handlers.get(event.type);
    if (!handlers?.length) throw new Error('No handler for event');
    await this.db.withTenant(event.businessId, async tx => {
      const inserted = await tx.query('INSERT INTO service_inbox(consumer,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id', [this.options.name, event.id]);
      if (!inserted.rowCount) return;
      for (const handler of handlers) await handler(event, tx);
    });
  }
  async flushOutbox(): Promise<void> {
    if (!isCloudflareRuntime()) { await this.flush(); return; }
    const bindings = currentCloudflareBindings();
    if (!bindings) throw new Error('Event publication requires an active invocation');
    // SKIP LOCKED makes concurrent requests safe without a process-wide busy flag.
    // A partial fanout rolls back publication; consumers deduplicate its retry.
    await this.db.transaction(async tx => {
      const { rows } = await tx.query<{ id: string; event: PlatformEvent }>('SELECT id,event FROM service_outbox WHERE published_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50');
      for (const row of rows) {
        const event = platformEventSchema.parse(row.event);
        if (event.producer !== this.options.name || event.producer !== event.type.split('.')[0]) throw new Error('Invalid outbox producer');
        const message = await encodeQueueEvent(event);
        for (const subscription of eventConsumerSubscriptions) {
          if (!(subscription.types as readonly string[]).includes(event.type)) continue;
          const key = `EVENTS_${subscription.consumer.toUpperCase()}`;
          const queue = bindings[key] as { send?: (event: QueueEvent, options: { contentType: 'json' }) => Promise<void> } | undefined;
          if (typeof queue?.send !== 'function') throw new Error(`Missing ${key} queue binding`);
          await queue.send(message, { contentType: 'json' });
        }
        await tx.query('UPDATE service_outbox SET published_at=now() WHERE id=$1', [row.id]);
      }
    });
  }
  /** Published payloads may expire; inbox IDs remain permanent replay tombstones.
   * Pending payloads are never pruned, including failed/partially published fanout.
   * Thirty days exceeds the seven-day transport pointer window. Pruned events
   * cannot be replayed from the producer; historical replay needs a new event ID.
   */
  async prunePublishedOutbox(): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.query(`DELETE FROM service_outbox WHERE id IN (
        SELECT id FROM service_outbox WHERE published_at < now() - interval '30 days'
        ORDER BY published_at FOR UPDATE SKIP LOCKED LIMIT 1000)`);
      await tx.query(`DELETE FROM service_request_budgets WHERE window_start < now() - interval '1 day'`);
    });
  }
  private async flush() {
    if(this.busy || !this.connected || !this.channel)return;
    this.busy=true;
    const channel=this.channel;
    try {
      await this.db.transaction(async tx=>{
        const {rows}=await tx.query<{id:string;event:PlatformEvent}>('SELECT id,event FROM service_outbox WHERE published_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50');
        for(const row of rows){
          await new Promise<void>((resolve,reject)=>channel.publish(exchange,row.event.type,Buffer.from(JSON.stringify(row.event)),{persistent:true,contentType:'application/json',messageId:row.id},err=>err?reject(err):resolve()));
          await tx.query('UPDATE service_outbox SET published_at=now() WHERE id=$1',[row.id]);
        }
      });
    } catch { /* Unsent outbox records are retried; no business mutation is lost. */ }
    finally {this.busy=false;}
  }
  async onApplicationShutdown(){
    this.stopping=true;
    this.connected=false;
    if(this.interval)clearInterval(this.interval);
    if(this.reconnect)clearTimeout(this.reconnect);
    const connection=this.connection;
    this.connection=undefined;
    this.channel=undefined;
    await connection?.close().catch(()=>{});
  }
}
