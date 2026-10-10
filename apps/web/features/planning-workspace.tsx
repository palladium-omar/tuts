import { useEffect, useState } from 'react';
import { hasPermission } from '@palladium/contracts';
import { ArrowLeft } from 'lucide-react';
import { type Api, type Business, type Row, errorMessage } from '../lib/api';
import { Empty, Notice } from '../components/shared';
import { StudentBoards } from './student-boards';

export function PlanningWorkspace({api,business,initialStudentId}:{api:Api;business:Business;initialStudentId?:string}) {
 const [studentId,setStudentId]=useState(initialStudentId), [students,setStudents]=useState<Row[]>([]),[offset,setOffset]=useState(0),[total,setTotal]=useState(0),[loading,setLoading]=useState(false),[error,setError]=useState('');
 useEffect(()=>{setStudentId(initialStudentId);},[initialStudentId,business.id]);
 useEffect(()=>{let cancelled=false;if(studentId||!hasPermission(business,"clients.read")){setLoading(false);return;}setLoading(true);setError('');api(`clients/v1/portal/students?limit=50&offset=${offset}`).then(data=>{if(!cancelled){setStudents(data.items??[]);setTotal(data.total??0);}}).catch(e=>{if(!cancelled)setError(errorMessage(e));}).finally(()=>{if(!cancelled)setLoading(false);});return()=>{cancelled=true;};},[api,offset,studentId,business]);
 if(studentId)return <><button onClick={()=>setStudentId(undefined)}><ArrowLeft size={16}/> Choose another student</button><StudentBoards key={`${business.id}:${studentId}`} api={api} business={business} studentId={studentId}/></>;
 if(!hasPermission(business,"clients.read"))return <Empty>Choosing a student requires access to student records.</Empty>;
 return <section><div className="section-heading"><div><h1>Student boards</h1><p className="muted">Choose a student to organize applications, goals and tasks into separate boards.</p></div></div><Notice error={error}/>{loading?<Empty>Loading students…</Empty>:<div className="tracker-student-grid">{students.map(student=><button className="panel" key={student.id} onClick={()=>setStudentId(student.id)}>{student.displayName}</button>)}</div>}{!loading&&!students.length&&!error&&<Empty>Add a student in the CRM to create their first board.</Empty>}<div className="pagination"><span>{total} students</span><button disabled={loading||offset===0} onClick={()=>setOffset(n=>Math.max(0,n-50))}>Previous</button><button disabled={loading||offset+50>=total} onClick={()=>setOffset(n=>n+50)}>Next</button></div></section>;
}
