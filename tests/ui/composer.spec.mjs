import { test, expect } from '@playwright/test';
test('conversation starter preserves drafts, history and responsive layout', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#slot-select option')).not.toHaveCount(0);
  await page.locator('#chat-input').fill('这段草稿保留');
  await page.locator('#image-file').setInputFiles('public/icon-256.png');
  await expect(page.locator('#image-preview img')).toHaveCount(1);
  await page.getByRole('button',{name:'先让模型说话',exact:true}).dblclick();
  await expect(page.locator('#first-speak')).toBeDisabled();
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await expect(page.locator('#first-speak')).toBeEnabled();
  await expect(page.locator('#chat-input')).toHaveValue('这段草稿保留');
  await expect(page.locator('#image-preview img')).toHaveCount(1);
  await expect(page.locator('.conversation-cue')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  for (const width of [1280,760,620]) {
    await page.setViewportSize({width,height:900});
    const a=await page.locator('#first-speak').boundingBox(), b=await page.locator('#send').boundingBox();
    expect(a.x+a.width).toBeLessThanOrEqual(b.x);expect(a.y).toBe(b.y);expect(b.x+b.width).toBeLessThanOrEqual(width);
    expect(await page.locator('#chat-form').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBeTruthy();
  }
  expect(errors).toEqual([]);
});
