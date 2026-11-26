import GameArt from './GameArt';
export const missions = ['출렁다리', '가시덤불', '드래곤', '공주의 성'];
export const missionArt = ['bridge', 'thorns', 'dragon', 'castle'];
export function QuestMap({ completed }: { completed: number }) {
 return <section className="quest-map" aria-label={'퀘스트 지도: 4개 중 '+completed+'개 완료'}><div className="map-heading"><span>YOUR ADVENTURE</span><strong>{completed >= 4 ? 'Mission Complete!' : completed+' / 4 미션 완료'}</strong></div><ol className="map-path">{missions.map((name,i)=><li key={name} className={i<completed?'cleared':i===completed?'current':''}><div className="map-node"><GameArt name={missionArt[i]} alt=""/>{i<completed&&<span className="map-check" aria-hidden="true">✓</span>}</div><strong>{name}</strong><small>{i<completed?'완료':i===completed?'다음 목적지':'도전 대기'}</small></li>)}</ol><p>기간 안에 90% 이상 달성하면 한 칸 전진해요.</p></section>;
}
export function Castle({ opening = false }: { opening?: boolean }) {return <div className={'castle-art '+(opening?'opening':'')}><GameArt name="gate" alt="황금빛 등불이 켜진 모험의 성문" priority/><div className="gate-glow" aria-hidden="true"/></div>;}
