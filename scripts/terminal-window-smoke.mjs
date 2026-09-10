// Opens one short-lived, harmless console and verifies its actual visibility.
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {agentTerminalSpawnSpec} from '../dist/clients/agent-terminal-process.js';
const dir=resolve('.provider-dock/terminal-smoke');await mkdir(dir,{recursive:true});
const output=resolve(dir,'visibility-'+Date.now()+'.json');
const script=`Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ConsoleTest {
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
}
'@
Write-Host 'ProviderDock: проверка видимого окна CLI (закроется автоматически через 5 секунд)'
$handle=[ConsoleTest]::GetConsoleWindow()
@{ console=$handle.ToInt64(); visible=[ConsoleTest]::IsWindowVisible($handle); terminal=$env:WT_SESSION; marker=$env:PROVIDERDOCK_SMOKE_MARKER; inputRedirected=[Console]::IsInputRedirected; outputRedirected=[Console]::IsOutputRedirected } | ConvertTo-Json | Set-Content -LiteralPath '${output.replaceAll("'","''")}' -Encoding UTF8
Start-Sleep -Seconds 5
exit 0`;
const fixture=resolve(dir,'console-check.ps1');await writeFile(fixture,'\ufeff'+script,'utf8');
const spec=agentTerminalSpawnSpec({executable:'powershell.exe',args:['-NoProfile','-ExecutionPolicy','Bypass','-File',fixture],cwd:dir,environment:{...process.env,PROVIDERDOCK_SMOKE_MARKER:'inherited'}});
console.log('Wrapper command characters:',spec.args.join(' ').length);
const child=spawn(spec.executable,[...spec.args],{...spec.options,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr?.on('data',chunk=>stderr+=chunk);
const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
const timer=setTimeout(()=>child.kill(),45000);
try {const exit=await finished;console.log('Wrapper exit:',exit);const result=JSON.parse((await readFile(output,'utf8')).replace(/^\uFEFF/,''));console.log(result);if(exit.code!==0||(!result.visible&&!result.terminal)||result.marker!=='inherited'||result.inputRedirected||result.outputRedirected)process.exitCode=1;}
catch(error){console.error(error.message,stderr.slice(-2000));process.exitCode=1;}
finally{clearTimeout(timer)}
