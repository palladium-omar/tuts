import { ApiError, type Row } from '../../lib/api';
import { portalUuid } from './homework-navigation';
export type ReminderTarget = {targetKind:'homework';assignmentId:string} | {targetKind:'planning';boardId:string;cardId:string};
export function reminderPresets(dueAt?:string|null, now=Date.now()) {
  const tomorrow=new Date(now);tomorrow.setDate(tomorrow.getDate()+1);tomorrow.setHours(9,0,0,0);
  const result=[{label:'Tomorrow at 9 am',instant:tomorrow.toISOString()}];
  if(dueAt&&Number.isFinite(Date.parse(dueAt))) {const before=new Date(dueAt);before.setDate(before.getDate()-1);if(before.getTime()>now+60_000)result.push({label:'Day before due',instant:before.toISOString()});}
  return result;
}
export function reminderTime(value:string, now=Date.now()) {
  const time=Date.parse(value);
  if(!Number.isFinite(time)||time<now+60_000||time>now+365*86400000)throw new Error('Choose a time at least one minute from now and within the next year.');
  return new Date(time).toISOString();
}
export function reminderError(error:unknown) {
  if(error instanceof ApiError) {
    if(error.status===409)return 'This reminder changed or already exists. Refresh reminders and try again.';
    if([401,403,404].includes(error.status))return 'Reminders are unavailable for this task or your access has changed.';
    if(error.status===503)return 'Reminders are temporarily unavailable. Please retry.';
  }
  return 'Couldn’t save this reminder. Please retry.';
}
export function reminderPath(row:Row,studentId:string,businessId:string) {
  if(row.studentId!==studentId||!portalUuid(studentId))return null;
  const url=new URL('/portal','https://local');url.searchParams.set('business',businessId);url.searchParams.set('student',studentId);
  if(row.targetKind==='homework'&&portalUuid(row.assignmentId)){url.searchParams.set('section','homework');url.searchParams.set('assignment',row.assignmentId);}
  else if(row.targetKind==='planning'&&portalUuid(row.boardId)&&portalUuid(row.cardId)){url.searchParams.set('section','planning');url.searchParams.set('board',row.boardId);url.searchParams.set('card',row.cardId);}
  else return null;
  return `${url.pathname}${url.search}`;
}
export function emailReminderLabel(row:Row) {
  if(!row.emailEnabled)return 'In-app reminder';
  const labels:Record<string,string>={pending:'Email pending',sending:'Email being sent',accepted:'Email accepted by sender',failed:'Email failed · in-app reminder available',unknown:'Email outcome unknown · in-app reminder available',suppressed:'Email stopped · access or task changed',disabled:'Email unavailable · in-app reminder available'};
  return labels[row.emailStatus]??'Email status unavailable';
}
