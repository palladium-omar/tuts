"use client";
import { useEffect, useRef, useState } from 'react';
import { hasPermission } from '@palladium/contracts';
import { ArrowUpRight, BookOpen, CalendarDays, CheckCircle2, ListTodo } from 'lucide-react';
import { date, errorMessage, type Api, type Business, type Row } from '../../lib/api';
import { overviewLink, overviewDeadlineLabel, priorityPlanningTasks, progressPercent } from './overview-model';
import {createOverviewLoader, type OverviewLoad} from './overview-loader';
import './overview.css';
type Domain = 'learning' | 'planning' | 'scheduling';
type Load = OverviewLoad;
const titles = {learning:'Homework',planning:'Planning',scheduling:'Sessions'};
export function PortalOverview({api,business,studentId,onNavigate}:{api:Api;business:Business;studentId:string;onNavigate:(section:string,boardId?:string,cardId?:string)=>void}) {
  const [states,setStates]=useState<Partial<Record<Domain,Load>>>({});
  const permitted = (domain:Domain)=>business.entitlements.includes(domain)&&hasPermission(business,`${domain}.read`);
  const domains = (['learning','planning','scheduling'] as Domain[]).filter(permitted);
  const coverage = domains.join(',');
  const loader=useRef<ReturnType<typeof createOverviewLoader>|null>(null);
  useEffect(()=>{
    setStates({});
    const current=createOverviewLoader(api,domains,studentId,
      (domain,state)=>setStates(old=>({...old,[domain]:state})),errorMessage);
    loader.current=current;
    return ()=>{current.dispose();if(loader.current===current)loader.current=null;};
  },[api,studentId,coverage]);
  async function retry(domain:Domain) {await loader.current?.refresh(domain);}
  function link(section:string,label:string,boardId?:string,cardId?:string) {
    const href=overviewLink(typeof window==='undefined'?'https://local/portal':window.location.href,studentId,section,boardId,cardId);
    return <a href={href} onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onNavigate(section,boardId,cardId);}}}>{label}<ArrowUpRight size={15}/></a>;
  }
  function status(domain:Domain) {
    const state=states[domain];
    return !state||state.loading?<p className="muted" role="status">Loading {titles[domain].toLowerCase()}…</p>:state.error?<div role="alert"><p>Couldn’t load {titles[domain].toLowerCase()}. {state.error}</p><button onClick={()=>void retry(domain)}>Retry {titles[domain].toLowerCase()}</button></div>:null;
  }
  const learning=states.learning?.data,planning=states.planning?.data,scheduling=states.scheduling?.data;
  const priorityTasks=planning?priorityPlanningTasks(planning.tasks,planning.upcomingTasks):[];
  return <div className="student-overview">
    <div className="overview-intro"><div><span className="overview-eyebrow">Your next steps</span><h2>Keep your momentum.</h2><p className="muted">See what needs your attention and what’s coming up.</p></div><CheckCircle2 aria-hidden="true" size={38}/></div>
    {!domains.length?<div className="portal-card"><h3>Your overview is waiting.</h3><p>Your tutor has not enabled homework, planning or sessions in this space yet.</p></div>:<>
    {domains.filter(domain=>states[domain]?.data&&states[domain]?.error).map(domain=><p key={domain} className="muted" role="status">{titles[domain]} may be out of date. {states[domain]?.error} <button onClick={()=>void retry(domain)}>Retry {titles[domain].toLowerCase()}</button></p>)}
    <div className="overview-metrics">
      {permitted('learning')&&<article className="portal-card"><BookOpen aria-hidden="true"/><span>Homework to do</span>{learning?<><strong>{learning.summary.pending}</strong><small>{learning.summary.completed} completed{learning.summary.submitted ? ` · ${learning.summary.submitted} awaiting review` : ''}{learning.summary.overdue ? ` · ${learning.summary.overdue} past due` : ''}</small></>:status('learning')}</article>}
      {permitted('planning')&&<article className="portal-card"><ListTodo aria-hidden="true"/><span>Planning progress</span>{planning?<><strong>{planning.summary.completed}<span> / {planning.summary.total}</span></strong><progress aria-label="Planning tasks completed" max={100} value={progressPercent(planning.summary.completed,planning.summary.total)}/><small>{planning.summary.overdue?`${planning.summary.overdue} dates passed`:planning.summary.dueSoon?`${planning.summary.dueSoon} coming up`:'Tasks completed'}</small></>:status('planning')}</article>}
      {permitted('planning')&&<article className="portal-card"><CalendarDays aria-hidden="true"/><span>Due in the next 7 days</span>{planning?<><strong>{planning.summary.dueSoon}</strong><small>Planning dates and targets</small></>:status('planning')}</article>}
      {permitted('scheduling')&&<article className="portal-card"><CalendarDays aria-hidden="true"/><span>Upcoming sessions</span>{scheduling?<><strong>{scheduling.summary.upcoming}</strong><small>{scheduling.summary.completed} completed sessions</small></>:status('scheduling')}</article>}
    </div>
    <div className="overview-columns">
      {(permitted('learning')||permitted('planning'))&&<div className="overview-stack overview-stack-left">
      {permitted('learning')&&<article className="portal-card overview-section overview-homework"><header><h3>Homework to tackle</h3>{link('homework','All homework')}</header>{learning?<>{learning.homework.length?<ul>{learning.homework.map((item:Row)=><li key={item.id}><div><strong>{item.title}</strong><small>{item.status==='needs_revision'?'Revision requested · ':''}{item.dueAt?`${Date.parse(item.dueAt)<Date.now()?'Past due · ':'Due '}${date(item.dueAt)}`:'No due date'}</small></div>{link('homework','Open homework')}</li>)}</ul>:<p>{learning.summary.total?(learning.summary.submitted?'You’re caught up. Submitted work is waiting for your tutor’s review.':'You’re caught up. Your homework is complete.'):'Your tutor hasn’t assigned homework yet.'}</p>}{learning.summary.pending>learning.homework.length&&<p className="muted">Showing the next {learning.homework.length} of {learning.summary.pending} assignments.</p>}</>:status('learning')}</article>}
      {permitted('planning')&&<article className="portal-card overview-section overview-planning"><header><h3>Planning next steps</h3>{link('planning','All boards')}</header>{planning?<>{priorityTasks.length?<ul>{priorityTasks.map((item:Row)=><li key={item.id}><div><strong>{link('planning',item.title,item.boardId,item.id)}</strong><small>{item.boardName}</small>{overviewDeadlineLabel(item.deadline)&&<small className="overview-task-date">{overviewDeadlineLabel(item.deadline)}</small>}</div></li>)}</ul>:<p>{planning.summary.pending+planning.summary.inProgress?'See upcoming deadlines for your next dated tasks.':planning.summary.total?'Your planning tasks are complete.':'No shared planning tasks yet.'}</p>}{planning.summary.pending+planning.summary.inProgress>Math.min(5,planning.tasks.length)&&<p className="muted">Open your boards to see all remaining work.</p>}</>:status('planning')}</article>}
      </div>}
      {(permitted('planning')||permitted('scheduling'))&&<div className="overview-stack overview-stack-right">
      {permitted('planning')&&<article className="portal-card overview-section overview-deadlines"><header><h3>Upcoming deadlines</h3>{link('planning','All boards')}</header>{planning?<>{planning.upcomingTasks?.length?<ul>{planning.upcomingTasks.slice(0,5).map((item:Row)=><li key={item.id}><div><strong>{link('planning',item.title,item.boardId,item.id)}</strong><small>{item.boardName}</small>{overviewDeadlineLabel(item.deadline)&&<small className="overview-task-date">{overviewDeadlineLabel(item.deadline)}</small>}</div></li>)}</ul>:<p>No upcoming planning deadlines or targets yet.</p>}</>:status('planning')}</article>}
      {permitted('scheduling')&&<article className="portal-card overview-section overview-sessions"><header><h3>Coming up</h3>{link('sessions','All sessions')}</header>{scheduling?<>{scheduling.sessions.length?<ul>{scheduling.sessions.map((item:Row)=><li key={`${item.source}:${item.id}`}><div><strong>{item.title}</strong><small>{date(item.startsAt)} – {date(item.endsAt)}</small></div>{link('sessions','View sessions')}</li>)}</ul>:<p>No upcoming sessions are linked to your record yet.</p>}{scheduling.summary.upcoming>scheduling.sessions.length&&<p className="muted">Showing the next {scheduling.sessions.length} sessions.</p>}</>:status('scheduling')}</article>}
      </div>}
    </div>
    {domains.length<3&&<p className="overview-coverage">This overview includes {domains.map(domain=>titles[domain].toLowerCase()).join(', ')} shared with your account.</p>}
    </>}
  </div>;
}
