import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

for (const method of ['file', 'paste'] as const) {
  test(`original image ${method} upload replaces a saved 10MB error with the uploaded image`, async ({ page, request }) => {
    const id = crypto.randomUUID();
    const response = await request.put(`/api/workflow/${id}`, { data: {
      id, baseVersion: 0, requestId: crypto.randomUUID(), snapshot: {
        name: '原图上传重试', nodes: [{ id: 'original', type: 'originalImage', position: { x: 100, y: 80 },
          data: { type: 'originalImage', label: '原图', error: 'File size exceeds 10MB' } }],
        edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      },
    } });
    expect(response.ok()).toBeTruthy();
    const imageUrl = 'https://upload-fixture.test/image.png';
    await page.route(imageUrl, route => route.fulfill({ path: path.resolve('tests/fixtures/h3/reference.png'), contentType: 'image/png' }));
    let uploads = 0;
    await page.route('**/api/upload/image', route => {
      uploads++;
      expect(route.request().postDataBuffer()!.length).toBeGreaterThan(10 * 1024 * 1024);
      return route.fulfill({ json: { success: true, data: { url: imageUrl } } });
    });
    await page.goto(`/?project=${id}`);
    const node = page.locator('.react-flow__node[data-id="original"]');
    await expect(node).toContainText('File size exceeds 10MB');
    await node.click();
    if (method === 'file') {
      await node.locator('input[type=file]').setInputFiles({ name: 'large.png', mimeType: 'image/png',
        buffer: Buffer.concat([readFileSync('tests/fixtures/h3/reference.png'), Buffer.alloc(11 * 1024 * 1024)]) });
    } else {
      await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([new Uint8Array(11 * 1024 * 1024)], 'pasted.png', { type: 'image/png' }));
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true }));
      });
    }
    await expect(node.getByAltText('Uploaded image')).toBeVisible();
    await expect(node).not.toContainText('File size exceeds 10MB');
    expect(uploads).toBe(1);
    await expect.poll(async () => {
      const body = await (await request.get(`/api/workflow/${id}`)).json();
      const data = body.data.nodes[0].data;
      return { error: data.error || null, imageSrc: data.imageSrc, isLoading: data.isLoading };
    }).toEqual({ error: null, imageSrc: imageUrl, isLoading: false });
    await page.reload();
    await expect(page.locator('.react-flow__node[data-id="original"]').getByAltText('Uploaded image')).toBeVisible();
  });
}
