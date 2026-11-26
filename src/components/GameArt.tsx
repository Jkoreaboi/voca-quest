'use client';
import Image from 'next/image';
import {useState} from 'react';
export default function GameArt({name,alt,priority=false,className=''}:{name:string;alt:string;priority?:boolean;className?:string}){const[failed,setFailed]=useState(false);return <div className={'game-art '+className}>{failed?<div className="art-fallback" role="img" aria-label={alt}>✦<span>{alt}</span></div>:<Image src={'/art/'+name+'.png'} alt={alt} width={1536} height={1024} sizes="(max-width:640px) 100vw, 640px" priority={priority} onError={()=>setFailed(true)}/>}</div>}
