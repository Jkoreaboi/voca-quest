'use client';
import { useEffect, useRef } from 'react';
export default function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
 const ref = useRef<HTMLDivElement>(null);
 useEffect(() => { const prior = document.activeElement as HTMLElement | null; const old = document.body.style.overflow; document.body.style.overflow = 'hidden'; ref.current?.focus(); return () => { document.body.style.overflow = old; prior?.focus(); }; }, []);
 return <div className="overlay"><div className="dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onKeyDown={e => { if(e.key === 'Escape') onClose(); if(e.key === 'Tab') { const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,a[href],select') || []); const first=items[0], last=items[items.length-1]; if(!first){e.preventDefault();return;} if(e.shiftKey && (document.activeElement === first || document.activeElement===ref.current)){ e.preventDefault();last.focus();} else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();} } }}><h2>{title}</h2>{children}</div></div>;
}
