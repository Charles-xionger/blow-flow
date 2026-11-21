import { useState, type FormEvent } from 'react'
import type { components } from '@blow-flow/api-client'
import { adminClient } from './api'
import { Button } from './components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card'
import { Input } from './components/ui/input'

type Task = components['schemas']['AdminGenerationTask']

const statusLabels: Record<string, string> = {
  queued: '排队中',
  submitting: '提交中',
  running: '供应商处理中',
  saving: '保存中',
  completed: '已交付',
  canceled: '已取消',
  failed: '生成失败',
  needs_review: '待核实',
  wait_timeout: '等待超时',
  query_failed: '查询失败',
  save_failed: '保存失败',
  save_exhausted: '保存重试已用尽',
  save_unavailable: '结果已不可保存',
}

const usageLabels: Record<string, string> = {
  consumeCoins: 'RunningHub 币消耗',
  consumeMoney: 'consumeMoney',
  thirdPartyConsumeMoney: 'thirdPartyConsumeMoney',
  settleMode: '结算方式',
  chargedPoint: '计费点数',
  taskCostTime: 'taskCostTime',
  input_images: '输入图张数',
  generated_images: '成功生成张数',
  output_tokens: '输出 Token',
  total_tokens: '总 Token',
  output_size: '输出尺寸',
}

export function GenerationTaskLookup({ token, onUnauthorized }: {
  token: string
  onUnauthorized: () => void
}) {
  const [id, setId] = useState('')
  const [task, setTask] = useState<Task | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const taskId = id.trim()
    if (!taskId || busy) return
    setBusy(true)
    setTask(null)
    setError('')
    try {
      const result = await adminClient(token).GET('/admin/generation/tasks/{id}', { params: { path: { id: taskId } } })
      if (result.data) {
        setTask(result.data)
      } else if (result.response.status === 401 || result.response.status === 403) {
        onUnauthorized()
      } else {
        setError(result.response.status === 404 ? '没有找到该任务，请核对任务 ID。' : '查询失败，请稍后重试。')
      }
    } catch {
      setError('查询失败，请检查 Go API 是否可用。')
    } finally {
      setBusy(false)
    }
  }

  return <Card>
    <CardHeader><CardTitle>按任务 ID 查询</CardTitle></CardHeader>
    <CardContent className='space-y-5'>
      <form className='flex flex-wrap items-end gap-3' onSubmit={event => void lookup(event)}>
        <label className='block w-full max-w-md space-y-1 text-sm font-medium'>
          <span>任务 ID</span>
          <Input value={id} onChange={event => setId(event.target.value)} maxLength={128} required disabled={busy} />
        </label>
        <Button type='submit' disabled={busy || !id.trim()}>{busy ? '查询中…' : '查询'}</Button>
      </form>
      {error && <p role='alert' className='text-sm text-destructive'>{error}</p>}
      {task && <TaskDetail task={task} />}
    </CardContent>
  </Card>
}

function TaskDetail({ task }: { task: Task }) {
  const { usage } = task
  const supported = task.model === 'runninghub/h3' || task.model === 'doubao-seedream-5-0-pro-260628' || task.model === 'doubao-seedream-5-5-261028'
  const fields = Object.entries(usage?.fields ?? {})
  return <div className='space-y-4 border-t pt-4 text-sm' aria-live='polite'>
    <dl className='grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 break-words'>
      <dt>任务 ID</dt><dd>{task.id}</dd>
      <dt>模型</dt><dd>{task.model}</dd>
      <dt>平台连接</dt><dd>{task.connectionId}</dd>
      <dt>任务状态</dt><dd>{statusLabels[task.status] ?? task.status}</dd>
      {task.failureCode && <><dt>失败原因</dt><dd>{task.failureCode}</dd></>}
      <dt>供应商成本</dt><dd>{usage?.amount && usage.currency ? `${usage.amount} ${usage.currency}` : supported ? '待确认' : '暂未采集'}</dd>
      {usage && <><dt>用量来源</dt><dd>{usage.source === 'runninghub_outputs' ? 'RunningHub 任务结果' : '火山方舟图片生成响应'}</dd></>}
      {usage?.priceSource && <><dt>成本来源</dt><dd><a className='underline' href={usage.priceSource} target='_blank' rel='noreferrer'>火山方舟公开按量价表</a></dd></>}
    </dl>
    <div>
      <h2 className='mb-2 font-medium'>供应商用量</h2>
      {fields.length ? <dl className='grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 break-words'>
        {fields.map(([key, value]) => <div key={key} className='contents'><dt>{usageLabels[key] ?? key}</dt><dd>{value ?? '—'}</dd></div>)}
      </dl> : <p className='text-muted-foreground'>{supported ? '暂无供应商用量' : '该模型暂未采集用量'}</p>}
    </div>
  </div>
}
