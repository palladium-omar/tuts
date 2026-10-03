import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title:'Tuts · Your tutoring business', description:'An independent workspace for your tutoring business.' };
export default function Layout({children}:{children:React.ReactNode}){return <html lang="en"><body>{children}</body></html>;}
