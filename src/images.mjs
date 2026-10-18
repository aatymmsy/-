export function validateImage(value) {
  if (typeof value !== 'string') throw new Error('图片应为 data URL');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new Error('图片仅支持 PNG、JPEG、WebP');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 4 * 1024 * 1024) throw new Error('每张图片应小于4 MiB');
  const valid = match[1] === 'png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : match[1] === 'jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255 : data.toString('ascii',0,4) === 'RIFF' && data.toString('ascii',8,12) === 'WEBP';
  if (!valid) throw new Error('图片内容与格式不符');
  return value;
}
export function messageContent(text, images = []) {
  if (!Array.isArray(images) || images.length > 4) throw new Error('每次最多4张图片');
  if (!images.length) return text;
  return [{ type:'text', text: text?.trim() || '请看看这些图片。' }, ...images.map(value => ({ type:'image_url', image_url:{ url:validateImage(value), detail:'auto' } }))];
}
export const contentText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(p=>p.type==='text').map(p=>p.text).join('\n') : '';
export const contextChars = messages => JSON.stringify(messages.map(m=>({ ...m, content:Array.isArray(m.content) ? m.content.map(p=>p.type==='image_url'?{type:'image_url',image_url:'[图片]'}:p) : m.content }))).length;
