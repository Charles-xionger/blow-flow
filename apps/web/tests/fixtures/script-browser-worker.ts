// Deterministic provider boundary; API, database, workflow and output attachment are real.
import { getScriptService } from '../../lib/script/service';
const service = getScriptService();
const failed = new Set<string>();
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
async function main() {
 while (!stopping) {
  const worked = await service.runNext(async function* ({ prompt }) {
   if (prompt.includes('本次只做短片镜头骨架规划')) {
    yield JSON.stringify({ summary: '归家', shots: [{ title: '归家', duration: 15, action: '走进家门', characters: [], scene: '家', props: [] }] });
   } else if (prompt.includes('本次只为固定的资产名称')) {
    yield JSON.stringify({ characters: [], scene: [{ name: '家', description: '温暖的客厅' }], props: [] });
   } else if (prompt.includes('本次只完善指定镜头')) {
    if (prompt.includes('测试分镜失败') && !failed.has(prompt)) { failed.add(prompt); throw Error('fixture detail failure'); }
    yield JSON.stringify({ shots: [{ id: 'shot-001', visual: '走进客厅', size: '中景', lighting: '柔光', dialogue: '无', sound: '脚步声', camera: '缓慢推进' }] });
   } else {
    yield '勇士出发';
    yield '，平安归来。';
   }
  });
  if (!worked) await new Promise(resolve => setTimeout(resolve, 100));
 }
}
main().catch(() => { process.exitCode = 1; });
