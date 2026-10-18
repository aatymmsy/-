import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir,e.name)) : [join(dir,e.name)]);
for (const file of ['src','public','scripts','tests'].flatMap(files).filter(f=>/\.(mjs|js)$/.test(f))) execFileSync(process.execPath, ['--check',file], {stdio:'pipe'});
const tracked = execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\n').filter(Boolean);
for (const file of tracked) {
  if (/(^|\/)(data|node_modules|outputs|backups)\/|\.sqlite|(^|\/)\.env(?:\.|$)|(^|\/)config\.json$/.test(file)) throw Error(`Private/runtime file in release: ${file}`);
}
for (const file of ['README.md','README.en.md','LICENSE','package-lock.json']) if (!existsSync(file)) throw Error(`Missing ${file}`);
for (const file of ['README.md','README.en.md']) if (/妹居|移动端|手机Agent/.test(readFileSync(file,'utf8'))) throw Error('README must describe the standalone desktop product');
console.log('Syntax and release-file checks passed.');
