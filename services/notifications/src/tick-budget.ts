/** A private gateway tick expires after 30 seconds. Reserve eight seconds for
 * application startup, outbox publication and invocation/socket cleanup. */
export const notificationWorkBudgetMs=22_000;
export const reminderLeaseBudgetMs=18_000; // identity <=5s, mail <=12s, SQL margin
export const campaignLeaseBudgetMs=17_000; // Cloudflare provider <=15s, SQL margin
export function notificationDeadline(budgetMs=notificationWorkBudgetMs){return performance.now()+budgetMs;}
export function budgetRemaining(deadline:number){return deadline-performance.now();}
type Ticking={tick(deadline:number):Promise<void>};
/** Alternate priority without relying on isolate-local state. Slow providers may
 * exhaust this pass; the other queue gets first priority in the next cron slot. */
export async function runNotificationTicks(campaigns:Ticking,reminders:Ticking,wallTime=Date.now()){
 const deadline=notificationDeadline();
 const reminderFirst=Math.floor(wallTime/(15*60_000))%2===0;
 const first=reminderFirst?reminders:campaigns,second=reminderFirst?campaigns:reminders;
 await first.tick(deadline);await second.tick(deadline);
}
