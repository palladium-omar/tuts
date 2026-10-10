import type {Row} from '../lib/api';
import {Download, FileText} from 'lucide-react';
export function submittedWorkLink(value: unknown): string | null {
  try { const url = new URL(String(value)); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
/** Presentation only: authorization and private-file downloads belong to Learning. */
export function StudentSubmission({assignment, onDownload}: {assignment: Row; onDownload: (resource: Row) => void | Promise<void>}) {
  const url = submittedWorkLink(assignment.submissionUrl), resources: Row[] = assignment.submissionResources ?? [];
  if (!assignment.submissionText && !url && !resources.length) return null;
  return <section className="submission">
    <h3>Student work</h3>
    {assignment.submissionText && <p className="teaching-work-text">{assignment.submissionText}</p>}
    {url && <p><a href={url} target="_blank" rel="noopener noreferrer">Open submitted work ↗</a></p>}
    <div className="attachment-list">{resources.map(resource => <button key={resource.id} disabled={resource.storageStatus !== 'stored'} aria-label={`Download submitted ${resource.fileName ?? resource.title}`} onClick={() => void onDownload(resource)}><FileText size={16} /><span>{resource.fileName ?? resource.title}{resource.storageStatus !== 'stored' && <small>Download unavailable</small>}</span><Download size={16} /></button>)}</div>
  </section>;
}
