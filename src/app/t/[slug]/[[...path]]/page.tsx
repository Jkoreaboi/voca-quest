import { notFound } from 'next/navigation';
import StudentApp from '../../../../components/StudentApp';
export default async function Page({ params }: { params: Promise<{ slug: string; path?: string[] }> }) {
 const {slug,path=[]}=await params;
 const valid=path.length===0 || (path.length===1 && ['start','wrong-notes','records'].includes(path[0])) || (path.length===2 && ['play','result'].includes(path[0]) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path[1]));
 if(!valid)notFound();
 return <StudentApp key={slug} slug={slug} route={path}/>;
}
