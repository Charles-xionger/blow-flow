import { mkdir, writeFile } from 'node:fs/promises';
import { runSuite, dataset, evaluatePlan } from './suite';

const report = runSuite();
await mkdir('results', { recursive: true });
await writeFile('results/storyboard-contract.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ suite: report.suite, score: report.score, cases: report.items.length }));
if (report.score !== 1) process.exitCode = 1;

if (process.argv.includes('--publish')) {
  const { LANGFUSE_BASE_URL: baseUrl, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } = process.env;
  if (!baseUrl || !publicKey || !secretKey) throw Error('Explicit LANGFUSE_BASE_URL/PUBLIC_KEY/SECRET_KEY required to publish');
  const [{ LangfuseClient }, { LangfuseSpanProcessor }, { BasicTracerProvider }, { setLangfuseTracerProvider }] = await Promise.all([
    import('@langfuse/client'), import('@langfuse/otel'), import('@opentelemetry/sdk-trace-base'), import('@langfuse/tracing'),
  ]);
  const provider = new BasicTracerProvider({ spanProcessors: [new LangfuseSpanProcessor({ baseUrl, publicKey, secretKey })] });
  setLangfuseTracerProvider(provider);
  const client = new LangfuseClient({ baseUrl, publicKey, secretKey });
  try {
    const result = await client.experiment.run({
      name: report.suite,
      metadata: { kind: report.kind, datasetVersion: 1, providerCalls: 0 },
      data: dataset,
      task: async ({ input }) => evaluatePlan(String(input)),
      evaluators: [async ({ output, expectedOutput }) => ({ name: 'contract-correctness', value: Number(output === expectedOutput) })],
      maxConcurrency: 1,
    });
    if (result.itemResults.length !== dataset.length || result.itemResults.some(item => !item.evaluations.some(score => score.name === 'contract-correctness' && score.value === 1)))
      throw Error('Published experiment did not evaluate every case successfully');
    await client.flush();
    await provider.forceFlush();
    console.log('Langfuse experiment submitted; verify the run in the configured instance.');
  } finally { await provider.shutdown(); }
}
