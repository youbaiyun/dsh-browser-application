import { createServer } from 'node:http'
import { makeTaskInstance, TASK_IDS } from '../lib/tasks.mjs'

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function layout(instance, body, script = '') {
  const data = JSON.stringify({
    runId: instance.runId,
    taskId: instance.id,
    page: instance.page,
  }).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(instance.page.title)} · DSH Browser Benchmark</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #17202a; background: #f3f5f7; }
    body { margin: 0; }
    header { padding: 18px 28px; color: white; background: #16324f; }
    header strong { font-size: 20px; }
    main { width: min(920px, calc(100% - 40px)); margin: 28px auto; padding: 28px; background: white; border-radius: 12px; box-shadow: 0 8px 28px #19324f18; }
    h1 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid #dde3e8; }
    label { display: block; margin: 14px 0 5px; font-weight: 650; }
    input, select { box-sizing: border-box; width: min(420px, 100%); padding: 10px 12px; border: 1px solid #aeb9c4; border-radius: 7px; font: inherit; }
    input[type=checkbox] { width: auto; margin-right: 8px; }
    button { margin-top: 16px; padding: 10px 16px; border: 0; border-radius: 7px; color: white; background: #1769aa; font: 650 15px system-ui; cursor: pointer; }
    .product, .record { margin: 10px 0; padding: 14px; border: 1px solid #dce3e9; border-radius: 8px; }
    .product button { margin-left: 16px; }
    .notice { margin-top: 18px; padding: 12px; border-radius: 7px; color: #155724; background: #d4edda; }
    .lazy-spacer .record { min-height: 100px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <header><strong>DSH Browser Benchmark</strong></header>
  <main>${body}</main>
  <script>window.__BENCHMARK__ = ${data};</script>
  <script>
    async function benchmarkAction(action, payload = {}) {
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: window.__BENCHMARK__.runId, taskId: window.__BENCHMARK__.taskId, action, payload })
      });
      if (!response.ok) throw new Error('benchmark action failed');
      return response.json();
    }
    ${script}
  </script>
</body>
</html>`
}

function renderTask(instance) {
  const { id, page } = instance
  if (id === 'order_lookup') {
    const rows = page.orders.map((order) => `<tr><td>${htmlEscape(order.id)}</td><td>${htmlEscape(order.customer)}</td><td>¥${(order.cents / 100).toFixed(2)}</td></tr>`).join('')
    return layout(instance, `<h1>订单中心</h1><p>最近订单如下。</p><table><thead><tr><th>订单号</th><th>客户</th><th>总金额</th></tr></thead><tbody>${rows}</tbody></table>`)
  }
  if (id === 'notification_toggle') {
    return layout(instance, `<h1>账户设置</h1><p>账户：<strong>${htmlEscape(page.account)}</strong></p><form id="settings-form"><label><input id="email-notifications" type="checkbox">邮件通知</label><button type="submit">保存设置</button></form><p id="saved" class="notice" hidden>设置已保存</p>`, `
      document.querySelector('#settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await benchmarkAction('save-notifications', { enabled: document.querySelector('#email-notifications').checked });
        document.querySelector('#saved').hidden = false;
      });`)
  }
  if (id === 'contact_form') {
    return layout(instance, `<h1>联系信息</h1><form id="contact-form"><label for="name">姓名</label><input id="name" name="name" autocomplete="off"><label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="off"><label for="city">城市</label><input id="city" name="city" autocomplete="off"><button type="submit">提交联系信息</button></form><p id="submitted" class="notice" hidden>联系信息已提交</p>`, `
      document.querySelector('#contact-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await benchmarkAction('submit-contact', Object.fromEntries(form));
        document.querySelector('#submitted').hidden = false;
      });`)
  }
  if (id === 'inventory_filter') {
    return layout(instance, `<h1>库存查询</h1><form id="filter-form"><label for="sku">SKU 包含</label><input id="sku" name="sku" autocomplete="off"><label for="maximum">最高价格（元）</label><input id="maximum" name="maximum" inputmode="decimal" autocomplete="off"><button type="submit">应用筛选</button></form><section id="results" aria-live="polite"><p>请先应用筛选。</p></section>`, `
      const products = window.__BENCHMARK__.page.products;
      document.querySelector('#filter-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const sku = document.querySelector('#sku').value.trim();
        const maximumCents = Math.round(Number(document.querySelector('#maximum').value) * 100);
        await benchmarkAction('apply-filter', { sku, maximumCents });
        const matches = products.filter((product) => product.sku.includes(sku) && product.cents <= maximumCents);
        document.querySelector('#results').innerHTML = matches.length === 0
          ? '<p>没有匹配商品</p>'
          : matches.map((product) => '<article class="product"><strong>' + product.name + '</strong><br>SKU：' + product.sku + '<br>价格：¥' + (product.cents / 100).toFixed(2) + '</article>').join('');
      });`)
  }
  if (id === 'cart_checkout') {
    const products = page.products.map((product) => `<article class="product"><strong>${htmlEscape(product.name)}</strong><span> · ¥${(product.cents / 100).toFixed(2)}</span><button type="button" data-product-id="${htmlEscape(product.id)}">加入购物车</button></article>`).join('')
    return layout(instance, `<h1>商品目录</h1><section id="catalog">${products}</section><section id="cart" hidden><h2>购物车</h2><p id="cart-name"></p><label for="quantity">数量</label><input id="quantity" type="number" min="1" value="1"><button id="checkout" type="button">完成结算</button></section><p id="complete" class="notice" hidden>结算完成</p>`, `
      const products = window.__BENCHMARK__.page.products;
      let selected = null;
      for (const button of document.querySelectorAll('[data-product-id]')) {
        button.addEventListener('click', async () => {
          selected = button.dataset.productId;
          await benchmarkAction('add-cart', { productId: selected });
          const product = products.find((item) => item.id === selected);
          document.querySelector('#cart-name').textContent = product.name;
          document.querySelector('#cart').hidden = false;
        });
      }
      document.querySelector('#checkout').addEventListener('click', async () => {
        const quantity = Number(document.querySelector('#quantity').value);
        await benchmarkAction('checkout', { productId: selected, quantity });
        document.querySelector('#complete').hidden = false;
      });`)
  }
  const filler = Array.from({ length: page.fillerCount }, (_, index) => `<article class="record"><strong>历史记录 ${index + 1}</strong><p>这是用于测试滚动和懒加载的归档内容。</p></article>`).join('')
  return layout(instance, `<h1>归档记录</h1><p>目标记录位于当前已加载内容之后。</p><section class="lazy-spacer">${filler}</section><button id="load-more" type="button">加载更多记录</button><article id="new-record" class="record notice" hidden><strong>新记录</strong><p>目标代码：<span id="target-code"></span></p></article>`, `
    document.querySelector('#load-more').addEventListener('click', async () => {
      await benchmarkAction('load-more');
      document.querySelector('#target-code').textContent = window.__BENCHMARK__.page.code;
      document.querySelector('#new-record').hidden = false;
      document.querySelector('#load-more').disabled = true;
    });`)
}

function initialState(taskId) {
  return { taskId, createdAt: Date.now() }
}

function applyAction(state, taskId, action, payload) {
  if (taskId === 'notification_toggle' && action === 'save-notifications') {
    return { ...state, notificationSaved: true, emailNotifications: payload.enabled === true, updatedAt: Date.now() }
  }
  if (taskId === 'contact_form' && action === 'submit-contact') {
    return { ...state, formSubmitted: true, form: { name: String(payload.name ?? ''), email: String(payload.email ?? ''), city: String(payload.city ?? '') }, updatedAt: Date.now() }
  }
  if (taskId === 'inventory_filter' && action === 'apply-filter') {
    return { ...state, filterApplied: true, filter: { sku: String(payload.sku ?? ''), maximumCents: Number(payload.maximumCents) }, updatedAt: Date.now() }
  }
  if (taskId === 'cart_checkout' && action === 'add-cart') {
    return { ...state, cart: { productId: String(payload.productId ?? ''), quantity: 1 }, updatedAt: Date.now() }
  }
  if (taskId === 'cart_checkout' && action === 'checkout') {
    return { ...state, checkedOut: true, cart: { productId: String(payload.productId ?? ''), quantity: Number(payload.quantity) }, updatedAt: Date.now() }
  }
  if (taskId === 'lazy_load' && action === 'load-more') {
    return { ...state, loadedMore: true, updatedAt: Date.now() }
  }
  throw new Error(`invalid action ${action} for ${taskId}`)
}

export async function startBenchmarkSite({ host = '127.0.0.1', port = 4173 } = {}) {
  const states = new Map()
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host ?? `${host}:${port}`}`
    const url = new URL(request.url ?? '/', origin)
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        const body = await readJson(request)
        if (typeof body.runId !== 'string' || !TASK_IDS.includes(body.taskId)) throw new Error('invalid reset payload')
        const state = initialState(body.taskId)
        states.set(body.runId, state)
        json(response, 200, state)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const runId = url.searchParams.get('run') ?? ''
        json(response, 200, states.get(runId) ?? {})
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await readJson(request)
        if (typeof body.runId !== 'string' || !TASK_IDS.includes(body.taskId) || typeof body.action !== 'string') throw new Error('invalid action payload')
        const current = states.get(body.runId) ?? initialState(body.taskId)
        const next = applyAction(current, body.taskId, body.action, body.payload ?? {})
        states.set(body.runId, next)
        json(response, 200, next)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/task/')) {
        const taskId = url.pathname.slice('/task/'.length)
        const seed = Number(url.searchParams.get('seed'))
        const runId = url.searchParams.get('run') ?? ''
        if (!TASK_IDS.includes(taskId) || !Number.isInteger(seed) || seed < 1 || runId === '') {
          json(response, 400, { error: 'invalid task URL' })
          return
        }
        states.set(runId, states.get(runId) ?? initialState(taskId))
        const instance = makeTaskInstance(taskId, seed, runId, origin)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderTask(instance))
        return
      }
      json(response, 404, { error: 'not found' })
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    origin: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.BENCHMARK_SITE_PORT ?? 4173)
  const site = await startBenchmarkSite({ port })
  console.log(`benchmark site listening on ${site.origin}`)
}
