"use client";
import { useEffect, useId, useState } from 'react';
import { hasPermission } from '@palladium/contracts';
import { Bell } from 'lucide-react';
import { date, type Api, type Business, type Row } from '../../lib/api';
import { DatePicker } from '../../components/date-picker';
import { zonedDateInput, zonedDateInstant } from '../../lib/zoned-date';
import { emailReminderLabel, reminderError, reminderPath, reminderPresets, reminderTime, type ReminderTarget } from './reminder-model';
import './reminders.css';
export function canReadReminders(business:Business) {return ['student','parent'].includes(business.role)&&business.entitlements.includes('notifications')&&hasPermission(business,'notifications.read');}
export function canUseReminders(business:Business) {return canReadReminders(business)&&hasPermission(business,'notifications.write');}
const listPath=(studentId:string)=>`notifications/v1/portal/reminders?${new URLSearchParams({studentId,limit:'50',offset:'0'})}`;
export function ReminderControl({api,studentId,allowed,target,dueAt,completed=false,onChanged}:{onChanged?:()=>void;api:Api;studentId:string;allowed:boolean;target:ReminderTarget;dueAt?:string|null;completed?:boolean}) {
  const id=useId(),[expanded,setExpanded]=useState(false),[busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[emailAvailable,setEmailAvailable]=useState(false),[emailEnabled,setEmailEnabled]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(''),[revision,setRevision]=useState(0),[existing,setExisting]=useState<Row[]>([]),[optionsReady,setOptionsReady]=useState(false),[loadError,setLoadError]=useState('');
  const [timeZone]=useState(()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
  const [when,setWhen]=useState(()=>zonedDateInput(reminderPresets(dueAt)[0]!.instant,timeZone));
  const targetKey=JSON.stringify(target);
  useEffect(()=>{
    if(!expanded||!allowed)return;
    const controller=new AbortController();setLoading(true);setLoadError('');setOptionsReady(false);setEmailAvailable(false);setExisting([]);
    api(listPath(studentId),'GET',undefined,undefined,{signal:controller.signal,fresh:true}).then(data=>{
      if(controller.signal.aborted)return;setOptionsReady(true);setEmailAvailable(data.emailAvailable===true);
      setExisting((data.items??[]).filter((row:Row)=>row.state==='scheduled'&&row.targetKind===target.targetKind&&(target.targetKind==='homework'?row.assignmentId===target.assignmentId:row.cardId===target.cardId&&row.boardId===target.boardId)));
    }).catch(e=>{if(!controller.signal.aborted)setLoadError(e instanceof Error&&'status' in e&&[401,403,404].includes(Number(e.status))?reminderError(e):'Couldn’t load reminder options. Retry to check availability.');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[api,studentId,expanded,allowed,targetKey,revision]);
  async function save() {
    if(busy||loading||!optionsReady)return;setError('');setSaved('');
    let remindAt:string;try{remindAt=reminderTime(zonedDateInstant(when,timeZone)??'');}catch(e){setError(e instanceof Error?e.message:'Choose a reminder time.');return;}
    setBusy(true);
    try{await api('notifications/v1/portal/reminders','POST',{studentId,...target,remindAt,emailEnabled:emailAvailable&&emailEnabled});setSaved(`Reminder saved for ${date(remindAt)}. ${emailAvailable&&emailEnabled?'Email is requested; its delivery status will appear in your reminders.':'It will appear in your overview.'}`);setExpanded(false);setEmailEnabled(false);onChanged?.();}catch(e){setError(reminderError(e));}finally{setBusy(false);}
  }
  async function cancel(row:Row) {setBusy(true);setError('');try{await api(`notifications/v1/portal/reminders/${row.id}`,'PATCH',{action:'cancel'});setRevision(n=>n+1);onChanged?.();}catch(e){setError(reminderError(e));}finally{setBusy(false);}}
  if(!allowed||completed)return null;
  return <div className="portal-reminder-control">
    <button type="button" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(value=>!value)} disabled={busy}><Bell size={15}/>Remind me</button>
    {saved&&<p role="status" className="crm-helper">{saved}</p>}
    {expanded&&<div id={id} className="portal-reminder-picker">
      <p className="crm-helper">Choose when to see this reminder in your overview.</p>
      <div className="portal-reminder-presets">{reminderPresets(dueAt).map(preset=><button type="button" disabled={busy} key={preset.label} onClick={()=>setWhen(zonedDateInput(preset.instant,timeZone))}>{preset.label}</button>)}</div>
      <DatePicker name={`reminder-${id}`} label="Reminder date and time" withTime value={when} onChange={setWhen} disabled={busy} required defaultTime="09:00"/>
      <small className="crm-helper">Time shown in {timeZone}.</small>
      {loading?<p className="crm-helper" role="status">Checking reminder options…</p>:!optionsReady?null:emailAvailable?<label className="portal-reminder-email"><input type="checkbox" checked={emailEnabled} disabled={busy} onChange={event=>setEmailEnabled(event.target.checked)}/>Also email my account</label>:<p className="crm-helper">Email reminders are unavailable. In-app reminders still work.</p>}
      {existing.map(row=><div key={row.id} className="portal-reminder-existing"><small>Scheduled {date(row.remindAt)}</small><button type="button" disabled={busy} onClick={()=>void cancel(row)}>Cancel reminder</button></div>)}
      {loadError&&<p role="alert" className="portal-reminder-error">{loadError} <button type="button" disabled={busy||loading} onClick={()=>setRevision(n=>n+1)}>Retry reminder options</button></p>}
      {error&&<p role="alert" className="portal-reminder-error">{error}{/changed or already exists/.test(error)&&<button type="button" disabled={busy||loading} onClick={()=>{setError('');setRevision(n=>n+1);}}>Refresh existing reminders</button>}</p>}
      <div className="form-actions"><button type="button" disabled={busy} onClick={()=>setExpanded(false)}>Close reminder options</button><button type="button" disabled={busy||loading||!optionsReady} className="primary" onClick={()=>void save()}>{busy?'Saving…':'Save reminder'}</button></div>
    </div>}
  </div>;
}
export function ReminderInbox({api,business,studentId,reloadToken=0}:{api:Api;business:Business;studentId:string;reloadToken?:number}) {
  const [rows,setRows]=useState<Row[]>([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0),[loading,setLoading]=useState(true),[error,setError]=useState(''),[revision,setRevision]=useState(0),[busyId,setBusyId]=useState('');
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setRows([]);
    api(`notifications/v1/portal/reminders?${new URLSearchParams({studentId,limit:'50',offset:String(offset)})}`,'GET',undefined,undefined,{signal:controller.signal,fresh:true}).then(data=>{if(!controller.signal.aborted){setRows(data.items??[]);setTotal(data.total??0);}}).catch(e=>{if(!controller.signal.aborted)setError(reminderError(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[api,studentId,offset,revision,reloadToken]);
  async function action(row:Row,action:'read'|'cancel') {setBusyId(row.id);setError('');try{await api(`notifications/v1/portal/reminders/${row.id}`,'PATCH',{action});setRows(items=>items.map(item=>item.id===row.id?{...item,state:action==='read'?'read':'cancelled'}:item));}catch(e){setError(reminderError(e));}finally{setBusyId('');}}
  const due=rows.filter(row=>row.state==='due');const scheduled=rows.filter(row=>row.state==='scheduled');
  return <details className="portal-reminder-inbox" open={due.length>0||undefined}><summary><Bell size={16}/>Reminders{due.length>0&&<span className="tag">{due.length} to read</span>}</summary>
    <button type="button" className="portal-reminder-refresh" disabled={loading||!!busyId} onClick={()=>setRevision(n=>n+1)}>Refresh reminders</button>
    {loading&&<p className="crm-helper" role="status">Loading reminders…</p>}
    {error&&<p className="portal-reminder-error" role="alert">{error} <button disabled={loading||!!busyId} onClick={()=>setRevision(n=>n+1)}>Retry reminders</button></p>}
    {!loading&&!error&&!due.length&&!scheduled.length&&<p className="crm-helper">No reminders here. Use “Remind me” on homework or a planning task.</p>}
    {[...due,...scheduled].map(row=>{const href=reminderPath(row,studentId,business.id);return <div className="portal-reminder-inbox-row" key={row.id}><div>{href?<a href={href}>{row.title}</a>:<strong>{row.title}</strong>}<small>{row.state==='due'?'Ready · ':'Scheduled · '}{date(row.remindAt)}</small><small>{emailReminderLabel(row)}</small></div>{canUseReminders(business)&&<div className="portal-reminder-row-actions">{row.state==='due'&&<button disabled={!!busyId} onClick={()=>void action(row,'read')}>Mark read</button>}<button disabled={!!busyId} onClick={()=>void action(row,'cancel')}>Cancel</button></div>}</div>;})}
    {total>50&&<div className="portal-pagination"><button disabled={loading||offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>Previous reminders</button><span>{offset+1}–{Math.min(offset+50,total)} of {total}</span><button disabled={loading||offset+50>=total} onClick={()=>setOffset(n=>n+50)}>Next reminders</button></div>}
  </details>;
}
