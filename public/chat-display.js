(function(root){
  'use strict';
  function parts(value){
    // Never present provider reasoning as the character's voice. Tags inside code stay literal.
    const chunks=String(value||'').split(/(```[\s\S]*?```)/g),result=[];
    for(const chunk of chunks){
      if(chunk.startsWith('```')){result.push({kind:'code',text:chunk.replace(/^```[^\n]*\n?/, '').replace(/```$/, '')});continue;}
      const text=chunk.replace(/<记忆>[\s\S]*?<\/记忆>/g,'').replace(/<记忆>[\s\S]*$/g,'').replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*$/gi,'');
      const pattern=/<(角色心声|心声)>([\s\S]*?)<\/\1>/g;let cursor=0,match;
      const plain=s=>s.replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s*[-*]\s+/gm,'');
      while((match=pattern.exec(text))){if(match.index>cursor)result.push({kind:'text',text:plain(text.slice(cursor,match.index))});result.push({kind:'heart',text:plain(match[2].trim())});cursor=pattern.lastIndex;}
      if(cursor<text.length)result.push({kind:'text',text:plain(text.slice(cursor))});
    }
    return result.filter(p=>p.text.trim());
  }
  root.MeijuDisplay={parts};
})(globalThis);
