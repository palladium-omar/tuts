import { BadRequestException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
export const providers=['sandbox','stripe','paypal','bank'] as const;
export type Provider = typeof providers[number];
export function sandboxEnabled(env:NodeJS.ProcessEnv=process.env) {return env.ALLOW_SANDBOX_PAYMENTS==='true' && (env.NODE_ENV==='development'||env.NODE_ENV==='test');}
export function requireSandbox() {if(!sandboxEnabled())throw new ServiceUnavailableException('sandbox_payments_disabled');}
function encryptionKey() {
  const encoded=process.env.PAYMENT_ENCRYPTION_KEY;
  if(!encoded)throw new ServiceUnavailableException('payment_encryption_key_missing');
  const key=Buffer.from(encoded,'base64');
  if(key.length!==32 || key.toString('base64')!==encoded)throw new ServiceUnavailableException('payment_encryption_key_invalid');
  return key;
}
export function encryptCredentials(value:Record<string,string>) {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),ciphertext.toString('base64')].join('.');
}
export function decryptCredentials(value:string):Record<string,string> {
  const [version,iv,tag,ciphertext,...extra]=value.split('.');
  if(version!=='v1'||!iv||!tag||!ciphertext||extra.length)throw new BadRequestException('encrypted_credentials_invalid');
  const decipher=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64'));decipher.setAuthTag(Buffer.from(tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]).toString('utf8'));
}
export function catalogue() {
  return providers.map(provider=>({provider,displayName:{sandbox:'Sandbox (simulated)',stripe:'Stripe Connect',paypal:'PayPal Commerce Platform',bank:'Bank provider'}[provider],available:provider==='sandbox'&&sandboxEnabled(),simulated:provider==='sandbox',reason:provider==='sandbox'?(sandboxEnabled()?null:'sandbox_payments_disabled'):'integration_unavailable',capabilities:{createCheckout:provider==='sandbox'&&sandboxEnabled(),getPayment:provider==='sandbox'&&sandboxEnabled(),verifyWebhook:false,refund:false}}));
}
export interface AdapterConnection {id:string;businessId:string;provider:string;credentials:Record<string,string>;}
export interface Attempt {id:string;businessId:string;connectionId:string;provider:string;status:string;amountMinor:number;currency:string;providerReference:string;}
export interface PaymentAdapter {
  createCheckout(connection:AdapterConnection,attempt:Attempt):{providerReference:string;checkoutUrl:null;simulated:boolean};
  getPayment(connection:AdapterConnection,attempt:Attempt):{status:string;simulated:boolean};
  verifyWebhook(connection:AdapterConnection,raw:Buffer,headers:Record<string,string>):never;
  refund(connection:AdapterConnection,attempt:Attempt):never;
}
export function adapter(provider:Provider):PaymentAdapter {
  if(provider!=='sandbox')throw new UnprocessableEntityException(`${provider}_integration_unavailable`);
  requireSandbox();
  return {
    createCheckout:(connection,attempt)=>{
      if(connection.id!==attempt.connectionId||connection.businessId!==attempt.businessId||connection.provider!==attempt.provider)throw new BadRequestException('payment_connection_mismatch');
      return {providerReference:`sandbox:${attempt.id}`,checkoutUrl:null,simulated:true};
    },
    getPayment:(connection,attempt)=>{
      if(connection.id!==attempt.connectionId||connection.businessId!==attempt.businessId||connection.provider!==attempt.provider)throw new BadRequestException('payment_connection_mismatch');
      return {status:attempt.status,simulated:true};
    },
    verifyWebhook:()=>{throw new UnprocessableEntityException('sandbox_has_no_external_webhook');},
    refund:()=>{throw new UnprocessableEntityException('refund_unsupported');},
  };
}
export function nextPaymentStatus(current:'pending'|'confirmed',notification:'pending'|'confirmed') {return current==='confirmed'||notification==='confirmed'?'confirmed':'pending';}
