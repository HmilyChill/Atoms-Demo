/*!
 * Atoms Demo · 生成物渲染运行时 (app runtime)
 *
 * 设计要点（docs/03 §8）：
 *  - 纯原生 JS、零依赖、无构建步骤 —— 既能跑在沙箱 iframe 里，也能被导出包直接内联复用
 *  - Spec 驱动、确定性渲染：同一份 Spec 渲染结果一致
 *  - 只认组件白名单，遇到不支持的组件**明确报错**，绝不静默近似
 *  - 所有运行时错误都会被捕获并上报宿主（杜绝"白屏却宣称完成"）
 *  - 数据通过注入的 dataAdapter 读写：HTTP 适配器（在线预览）/ 本地适配器（导出包）
 */
(function (global) {
  'use strict'

  var VERSION = '1.0.0'
  var SUPPORTED = [
    'heading',
    'text',
    'callout',
    'form',
    'table',
    'list',
    'detail',
    'stats',
    'chart',
    'filter',
    'tabs',
  ]

  // ─────────────────────────── 基础工具 ───────────────────────────

  function el(tag, attrs, children) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k]
        if (k === 'class') node.className = v
        else if (k === 'text') node.textContent = v
        else if (k === 'html') node.innerHTML = v
        else if (k.indexOf('on') === 0 && typeof v === 'function') node.addEventListener(k.slice(2), v)
        else if (typeof v === 'boolean') {
          // ⚠️ 布尔属性必须"真则设、假则完全不设"。
          // 早期实现写成 setAttribute('disabled', String(false)) → 'disabled="false"'，
          // 而 HTML 里只要出现 disabled 属性（无论取值）按钮就会被禁用，
          // 导致所有"通过/驳回/确认/取消"按钮点不动。
          if (v) node.setAttribute(k, '')
        } else if (v !== null && v !== undefined) node.setAttribute(k, String(v))
      })
    }
    // 容错：children 允许传单个节点、字符串或数组
    if (children !== undefined && children !== null && !Array.isArray(children)) {
      children = [children]
    }
    ;(children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
    })
    return node
  }

  function fieldOf(spec, modelName, fieldName) {
    var model = (spec.dataModels || []).filter(function (m) {
      return m.name === modelName
    })[0]
    if (!model) return null
    return (
      (model.fields || []).filter(function (f) {
        return f.name === fieldName
      })[0] || null
    )
  }

  function modelOf(spec, modelName) {
    return (
      (spec.dataModels || []).filter(function (m) {
        return m.name === modelName
      })[0] || null
    )
  }

  function toNumber(v) {
    var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v))
    return isFinite(n) ? n : 0
  }

  function formatValue(value, field) {
    if (value === null || value === undefined || value === '') return '—'
    if (!field) return String(value)
    if (field.type === 'boolean') return value === true || value === 'true' ? '是' : '否'
    if (field.type === 'number') return String(toNumber(value))
    if (field.type === 'date') {
      var d = new Date(value)
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
      return String(value)
    }
    return String(value)
  }

  // ─────────────────────────── 数据适配器 ───────────────────────────

  /** HTTP 适配器：在线预览（沙箱内用短期令牌鉴权，不依赖 Cookie） */
  function createHttpAdapter(options) {
    var base = options.apiBase || ''
    var projectId = options.projectId
    var token = options.token || ''
    var headers = { 'Content-Type': 'application/json' }
    if (token) headers['X-Atoms-Preview-Token'] = token
    var credentials = token ? 'omit' : 'same-origin'

    function url(collection, recordId) {
      var u = base + '/api/projects/' + encodeURIComponent(projectId) + '/records/' + encodeURIComponent(collection)
      if (recordId) u += '/' + encodeURIComponent(recordId)
      if (token && !options.useHeaderOnly) u += (u.indexOf('?') >= 0 ? '&' : '?') + 'pt=' + encodeURIComponent(token)
      return u
    }

    function request(method, u, body) {
      return fetch(u, {
        method: method,
        headers: headers,
        credentials: credentials,
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (res) {
        return res
          .json()
          .catch(function () {
            return {}
          })
          .then(function (json) {
            if (!res.ok) {
              var msg = (json && json.error && json.error.message) || '请求失败（' + res.status + '）'
              var hint = json && json.error && json.error.hint
              throw new Error(hint ? msg + ' · ' + hint : msg)
            }
            return json.data
          })
      })
    }

    return {
      kind: 'http',
      list: function (collection) {
        return request('GET', url(collection)).then(function (d) {
          return (d && d.records) || []
        })
      },
      create: function (collection, record) {
        return request('POST', url(collection), { record: record })
      },
      update: function (collection, id, patch) {
        return request('PATCH', url(collection, id), { patch: patch })
      },
      remove: function (collection, id) {
        return request('DELETE', url(collection, id))
      },
    }
  }

  /** 本地适配器：导出包使用（纯静态，数据存 localStorage） */
  function createLocalAdapter(options) {
    var key = (options && options.storageKey) || 'atoms-app-records'
    function readAll() {
      try {
        return JSON.parse(localStorage.getItem(key) || '{}')
      } catch (e) {
        return {}
      }
    }
    function writeAll(all) {
      localStorage.setItem(key, JSON.stringify(all))
    }
    function uid() {
      return 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    }
    return {
      kind: 'local',
      list: function (collection) {
        var all = readAll()
        return Promise.resolve((all[collection] || []).slice().reverse())
      },
      create: function (collection, record) {
        var all = readAll()
        var row = Object.assign({}, record, { id: uid(), createdAt: new Date().toISOString() })
        all[collection] = all[collection] || []
        all[collection].push(row)
        writeAll(all)
        return Promise.resolve({ id: row.id })
      },
      update: function (collection, id, patch) {
        var all = readAll()
        all[collection] = (all[collection] || []).map(function (r) {
          return r.id === id ? Object.assign({}, r, patch) : r
        })
        writeAll(all)
        return Promise.resolve({ id: id })
      },
      remove: function (collection, id) {
        var all = readAll()
        all[collection] = (all[collection] || []).filter(function (r) {
          return r.id !== id
        })
        writeAll(all)
        return Promise.resolve({ removed: true })
      },
    }
  }

  // ─────────────────────────── 样式 ───────────────────────────

  var STYLE_ID = 'atoms-runtime-style'
  var CSS = [
    '.atoms-root{--atoms-primary:#4f46e5;--atoms-radius:10px;--atoms-gap:16px;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a;background:#f8fafc;min-height:100%;display:flex;flex-direction:column}',
    '.atoms-root *{box-sizing:border-box}',
    '.atoms-head{background:#fff;border-bottom:1px solid #e2e8f0;padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
    '.atoms-title{font-size:16px;font-weight:650;margin:0}',
    '.atoms-badge{font-size:11px;padding:2px 8px;border-radius:999px;background:#eef2ff;color:var(--atoms-primary);border:1px solid #e0e7ff}',
    '.atoms-nav{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}',
    '.atoms-nav button{border:1px solid transparent;background:transparent;padding:6px 12px;border-radius:var(--atoms-radius);cursor:pointer;font-size:13px;color:#475569}',
    '.atoms-nav button:hover{background:#f1f5f9}',
    '.atoms-nav button[aria-current="true"]{background:var(--atoms-primary);color:#fff}',
    '.atoms-body{padding:20px;display:flex;flex-direction:column;gap:var(--atoms-gap);max-width:1100px;width:100%;margin:0 auto}',
    '.atoms-card{background:#fff;border:1px solid #e2e8f0;border-radius:var(--atoms-radius);padding:16px}',
    '.atoms-h1{font-size:22px;font-weight:680;margin:0}',
    '.atoms-h2{font-size:15px;font-weight:640;margin:0 0 12px}',
    '.atoms-text{font-size:14px;line-height:1.7;color:#334155;margin:0;white-space:pre-wrap}',
    '.atoms-callout{font-size:13px;line-height:1.6;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:var(--atoms-radius);padding:10px 12px}',
    '.atoms-grid{display:grid;gap:12px}',
    '.atoms-grid.cols-2{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}',
    '.atoms-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}',
    '.atoms-field label{font-size:12px;color:#475569;font-weight:560}',
    '.atoms-field input,.atoms-field select,.atoms-field textarea{border:1px solid #cbd5e1;border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;background:#fff;color:inherit}',
    '.atoms-field input:focus,.atoms-field select:focus,.atoms-field textarea:focus{outline:2px solid var(--atoms-primary);outline-offset:-1px;border-color:var(--atoms-primary)}',
    '.atoms-field .err{color:#b91c1c;font-size:12px}',
    '.atoms-invalid{border-color:#dc2626 !important}',
    '.atoms-btn{border:1px solid var(--atoms-primary);background:var(--atoms-primary);color:#fff;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;font-family:inherit}',
    '.atoms-btn:hover{filter:brightness(1.06)}',
    '.atoms-btn:disabled{opacity:.55;cursor:not-allowed}',
    '.atoms-btn.ghost{background:#fff;color:#334155;border-color:#cbd5e1}',
    '.atoms-btn.danger{background:#fff;color:#b91c1c;border-color:#fecaca}',
    '.atoms-btn.sm{padding:4px 10px;font-size:12px}',
    '.atoms-actions{display:flex;gap:6px;flex-wrap:wrap}',
    '.atoms-table{width:100%;border-collapse:collapse;font-size:13px}',
    '.atoms-table th{text-align:left;color:#64748b;font-weight:560;padding:8px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap}',
    '.atoms-table td{padding:9px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}',
    '.atoms-table tr:hover td{background:#f8fafc}',
    '.atoms-empty{color:#94a3b8;font-size:13px;padding:18px 0;text-align:center}',
    '.atoms-stat{display:flex;flex-direction:column;gap:4px}',
    '.atoms-stat .v{font-size:26px;font-weight:700;color:var(--atoms-primary)}',
    '.atoms-stat .k{font-size:12px;color:#64748b}',
    '.atoms-toolbar{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}',
    '.atoms-toolbar .atoms-field{margin-bottom:0;min-width:160px}',
    '.atoms-msg{font-size:13px;padding:8px 10px;border-radius:8px;margin-top:10px}',
    '.atoms-msg.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}',
    '.atoms-msg.bad{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}',
    '.atoms-errbox{border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:var(--atoms-radius);padding:12px;font-size:12px;line-height:1.6}',
    '.atoms-loading{color:#94a3b8;font-size:13px}',
    '.atoms-tabs{display:flex;gap:6px;border-bottom:1px solid #e2e8f0;margin-bottom:12px;flex-wrap:wrap}',
    '.atoms-tabs button{border:none;background:transparent;padding:8px 12px;cursor:pointer;font-size:13px;color:#475569;border-bottom:2px solid transparent;font-family:inherit}',
    '.atoms-tabs button[aria-current="true"]{color:var(--atoms-primary);border-bottom-color:var(--atoms-primary);font-weight:600}',
    '.atoms-kv{display:grid;grid-template-columns:140px 1fr;gap:6px 12px;font-size:13px}',
    '.atoms-kv .k{color:#64748b}',
    '.atoms-list{display:flex;flex-direction:column;gap:8px}',
    '.atoms-list .item{border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;display:flex;justify-content:space-between;gap:12px;align-items:center}',
    '.atoms-list .item .t{font-size:14px;font-weight:560}',
    '.atoms-list .item .s{font-size:12px;color:#64748b}',
    '.atoms-chart{width:100%;height:auto;display:block}',
    '.atoms-select-mode [data-atoms-component]{cursor:crosshair;outline:1px dashed #c7d2fe;outline-offset:1px}',
    '.atoms-select-mode [data-atoms-component]:hover{outline:2px dashed var(--atoms-primary);outline-offset:2px;background:rgba(99,102,241,.06)}',
  ].join('\n')

  function ensureStyle(doc) {
    var d = doc || document
    if (d.getElementById(STYLE_ID)) return
    var style = d.createElement('style')
    style.id = STYLE_ID
    style.textContent = CSS
    d.head.appendChild(style)
  }

  // ─────────────────────────── 运行时 ───────────────────────────

  function renderApp(root, spec, options) {
    options = options || {}
    var doc = root.ownerDocument || document
    ensureStyle(doc)

    var adapter =
      options.dataAdapter ||
      createHttpAdapter({
        apiBase: options.apiBase || '',
        projectId: options.projectId,
        token: options.token,
      })

    var readOnly = !!options.readOnly
    /** 只读（分享）模式下不提供"选择元素"，因为无法回到工作台继续修改 */
    var selectable = options.selectable !== false && !readOnly
    var onError =
      options.onError ||
      function () {
        /* 默认静默，但仍会显示在界面上 */
      }

    var state = {
      pageId: null,
      activeTab: {},
      data: {},
      loading: {},
      loaded: {},
      filters: {},
      errors: [],
      selected: {},
      /** 顶部反馈条（必须跨 paint() 存活，否则"保存成功"会被列表刷新吞掉） */
      flash: null,
      /** 选中元素模式（Atoms 的招牌交互：点界面 → 定向修改） */
      selectMode: false,
    }

    root.classList.add('atoms-root')
    root.innerHTML = ''

    function reportError(scope, err) {
      var message = err && err.message ? err.message : String(err)
      state.errors.push({ scope: scope, message: message, at: new Date().toISOString() })
      try {
        onError({ scope: scope, message: message })
      } catch (e) {
        /* 上报本身失败也不能让渲染崩掉 */
      }
    }

    /** 顶部反馈条：跨 paint() 存活，避免"保存成功"被随后的列表刷新吞掉 */
    function flash(kind, text) {
      state.flash = { kind: kind, text: text }
      paint()
      var token = text
      setTimeout(function () {
        if (state.flash && state.flash.text === token) {
          state.flash = null
          paint()
        }
      }, 4000)
    }

    function collectionsUsed() {      var names = {}
      ;(spec.pages || []).forEach(function (p) {
        ;(p.components || []).forEach(function walk(c) {
          if (c.model) names[c.model] = true
          if (c.type === 'tabs' && c.tabs) {
            c.tabs.forEach(function (t) {
              ;(t.components || []).forEach(walk)
            })
          }
        })
      })
      return Object.keys(names)
    }

    function loadAll(force) {
      var names = collectionsUsed()
      return Promise.all(
        names.map(function (name) {
          if (!force && state.loaded[name]) return Promise.resolve()
          state.loading[name] = true
          return adapter
            .list(name)
            .then(function (rows) {
              state.data[name] = rows || []
              state.loaded[name] = true
            })
            .catch(function (err) {
              state.data[name] = state.data[name] || []
              reportError('加载「' + name + '」数据', err)
            })
            .then(function () {
              state.loading[name] = false
            })
        }),
      ).then(function () {
        paint()
        notify('data-changed', {})
      })
    }

    function notify(type, payload) {
      if (global.parent && global.parent !== global) {
        try {
          global.parent.postMessage({ source: 'atoms-preview', type: type, payload: payload || {} }, '*')
        } catch (e) {
          /* 跨源 postMessage 失败不应影响应用 */
        }
      }
    }

    function rowsOf(modelName) {
      var rows = (state.data[modelName] || []).slice()
      var model = modelOf(spec, modelName)
      if (!model) return rows
      ;(model.fields || []).forEach(function (f) {
        var key = modelName + ':' + f.name
        var v = state.filters[key]
        if (v === undefined || v === '' || v === '__all__') return
        rows = rows.filter(function (r) {
          if (f.type === 'boolean') return String(r[f.name] === true) === v
          return String(r[f.name]) === v
        })
      })
      return rows
    }

    // ── 组件渲染 ──

    function renderComponentInner(c) {
      switch (c.type) {
        case 'heading':
          return el('h2', { class: 'atoms-h1', text: c.text || '' })
        case 'text':
          return el('p', { class: 'atoms-text', text: c.text || '' })
        case 'callout':
          return el('div', { class: 'atoms-callout', text: c.text || '' })
        case 'stats':
          return renderStats(c)
        case 'filter':
          return renderFilter(c)
        case 'form':
          return renderForm(c)
        case 'table':
          return renderTable(c)
        case 'list':
          return renderList(c)
        case 'detail':
          return renderDetail(c)
        case 'chart':
          return renderChart(c)
        case 'tabs':
          return renderTabs(c)
        default: {
          var box = el('div', { class: 'atoms-errbox' })
          box.appendChild(el('strong', { text: '不支持的组件：' + String(c.type) }))
          box.appendChild(el('div', { text: '运行时只渲染白名单内的组件，未做近似替代。' }))
          reportError('渲染组件', new Error('不支持的组件类型：' + String(c.type)))
          return box
        }
      }
    }

    /** 统一给每个组件打上标记，供"选中元素定向修改"定位 */
    function renderComponent(c) {
      var node = renderComponentInner(c)
      if (node && node.setAttribute) {
        node.setAttribute('data-atoms-component', c.id)
        node.setAttribute('data-atoms-type', c.type)
      }
      return node
    }

    function card(title, body, extraClass) {
      var wrap = el('section', { class: 'atoms-card ' + (extraClass || '') })
      if (title) wrap.appendChild(el('h3', { class: 'atoms-h2', text: title }))
      ;(Array.isArray(body) ? body : [body]).forEach(function (b) {
        if (b) wrap.appendChild(b)
      })
      return wrap
    }

    function renderStats(c) {
      var rows = rowsOf(c.model)
      var value = rows.length
      if (c.metric === 'sum' || c.metric === 'avg') {
        var total = rows.reduce(function (acc, r) {
          return acc + toNumber(r[c.metricField])
        }, 0)
        value = c.metric === 'avg' ? (rows.length ? total / rows.length : 0) : total
        value = Math.round(value * 100) / 100
      }
      var wrap = el('div', { class: 'atoms-stat' })
      wrap.appendChild(el('div', { class: 'v', text: String(value) }))
      wrap.appendChild(el('div', { class: 'k', text: c.title || modelLabel(c.model) + '统计' }))
      return card(null, wrap)
    }

    function modelLabel(name) {
      var m = modelOf(spec, name)
      return m ? m.label : name
    }

    function renderFilter(c) {
      var field = fieldOf(spec, c.model, c.filterField)
      var key = c.model + ':' + c.filterField
      var select = el('select', {
        onchange: function (e) {
          state.filters[key] = e.target.value
          paint()
        },
      })
      select.appendChild(el('option', { value: '__all__', text: '全部' }))
      var options = (field && field.options) || []
      if (field && field.type === 'boolean') options = ['true', 'false']
      options.forEach(function (o) {
        var label = field && field.type === 'boolean' ? (o === 'true' ? '是' : '否') : o
        select.appendChild(el('option', { value: String(o), text: label }))
      })
      select.value = state.filters[key] || '__all__'
      return card(
        c.title || '筛选',
        el('div', { class: 'atoms-toolbar' }, [el('div', { class: 'atoms-field' }, [el('label', { text: (field && field.label) || c.filterField }), select])]),
      )
    }

    function renderForm(c) {
      var model = modelOf(spec, c.model)
      if (!model) return card(c.title, el('div', { class: 'atoms-errbox', text: '表单绑定的数据集合不存在' }))
      if (readOnly) {
        return card(c.title, el('div', { class: 'atoms-callout', text: '只读分享链接：表单已隐藏，无法提交数据。' }))
      }

      var inputs = {}
      var errorNodes = {}
      var form = el('form', {
        onsubmit: function (e) {
          e.preventDefault()
          submit()
        },
      })

      ;(c.fields || []).forEach(function (fname) {
        var field = (model.fields || []).filter(function (f) {
          return f.name === fname
        })[0]
        if (!field) return
        var input
        if (field.type === 'select') {
          input = el('select')
          input.appendChild(el('option', { value: '', text: '请选择' }))
          ;(field.options || []).forEach(function (o) {
            input.appendChild(el('option', { value: o, text: o }))
          })
        } else if (field.type === 'boolean') {
          input = el('select')
          input.appendChild(el('option', { value: 'false', text: '否' }))
          input.appendChild(el('option', { value: 'true', text: '是' }))
        } else if (field.type === 'text') {
          input = el('textarea', { rows: 3 })
        } else if (field.type === 'number') {
          input = el('input', { type: 'number', step: 'any' })
        } else if (field.type === 'date') {
          input = el('input', { type: 'date' })
        } else {
          input = el('input', { type: 'text' })
        }
        if (field.defaultValue !== undefined && field.defaultValue !== null) {
          input.value = String(field.defaultValue)
        }
        inputs[field.name] = { input: input, field: field }
        var errNode = el('div', { class: 'err' })
        errorNodes[field.name] = errNode
        form.appendChild(
          el('div', { class: 'atoms-field' }, [
            el('label', { text: field.label + (field.required ? ' *' : '') }),
            input,
            errNode,
          ]),
        )
      })

      var msg = el('div', {})
      var button = el('button', { class: 'atoms-btn', type: 'submit', text: c.submitLabel || '保存' })
      form.appendChild(el('div', { class: 'atoms-actions' }, [button]))
      form.appendChild(msg)

      function clearErrors() {
        Object.keys(errorNodes).forEach(function (k) {
          errorNodes[k].textContent = ''
          inputs[k].input.classList.remove('atoms-invalid')
        })
      }

      function validate() {
        clearErrors()
        var okAll = true
        var record = {}
        Object.keys(inputs).forEach(function (name) {
          var item = inputs[name]
          var raw = item.input.value
          if (item.field.required && (raw === '' || raw === null)) {
            errorNodes[name].textContent = '此项为必填'
            item.input.classList.add('atoms-invalid')
            okAll = false
            return
          }
          if (raw === '') {
            record[name] = item.field.type === 'boolean' ? false : ''
            return
          }
          if (item.field.type === 'number') {
            var n = parseFloat(raw)
            if (!isFinite(n)) {
              errorNodes[name].textContent = '请输入数字'
              item.input.classList.add('atoms-invalid')
              okAll = false
              return
            }
            record[name] = n
          } else if (item.field.type === 'boolean') {
            record[name] = raw === 'true'
          } else {
            record[name] = raw
          }
        })
        return okAll ? record : null
      }

      function submit() {
        var record = validate()
        if (!record) {
          msg.className = 'atoms-msg bad'
          msg.textContent = '请先修正标红的字段'
          return
        }
        button.disabled = true
        adapter
          .create(c.model, record)
          .then(function () {
            form.reset()
            Object.keys(inputs).forEach(function (name) {
              var f = inputs[name].field
              if (f.defaultValue !== undefined && f.defaultValue !== null) inputs[name].input.value = String(f.defaultValue)
            })
            return loadAll(true)
          })
          .then(function () {
            flash('ok', '已保存，数据已持久化')
          })
          .catch(function (err) {
            msg.className = 'atoms-msg bad'
            msg.textContent = '保存失败：' + (err && err.message ? err.message : '未知错误')
            reportError('提交表单', err)
          })
          .then(function () {
            button.disabled = false
          })
      }

      return card(c.title || '新增' + model.label, form)
    }

    function renderTable(c) {
      var model = modelOf(spec, c.model)
      var rows = rowsOf(c.model)
      var cols = c.columns || []
      var table = el('table', { class: 'atoms-table' })
      var thead = el('thead')
      var tr = el('tr')
      cols.forEach(function (col) {
        var f = model ? (model.fields || []).filter(function (x) { return x.name === col.field })[0] : null
        tr.appendChild(el('th', { text: col.label || (f ? f.label : col.field) }))
      })
      var showActions = !readOnly && (c.rowActions || []).length > 0
      if (showActions) tr.appendChild(el('th', { text: '操作' }))
      thead.appendChild(tr)
      table.appendChild(thead)

      var tbody = el('tbody')
      if (rows.length === 0) {
        tbody.appendChild(
          el('tr', {}, [el('td', { colspan: String(cols.length + (showActions ? 1 : 0)) }, el('div', { class: 'atoms-empty', text: '暂无数据，先在上方新增一条试试' }))]),
        )
      }
      rows.forEach(function (r) {
        var row = el('tr')
        cols.forEach(function (col) {
          var f = model ? (model.fields || []).filter(function (x) { return x.name === col.field })[0] : null
          row.appendChild(el('td', { text: formatValue(r[col.field], f) }))
        })
        if (showActions) {
          var actions = el('div', { class: 'atoms-actions' })
          ;(c.rowActions || []).forEach(function (a) {
            if (a.kind === 'delete') {
              actions.appendChild(
                el('button', {
                  class: 'atoms-btn danger sm',
                  type: 'button',
                  text: a.label || '删除',
                  onclick: function () {
                    mutate(function () {
                      return adapter.remove(c.model, r.id)
                    }, '已删除')
                  },
                }),
              )
            } else if (a.kind === 'toggle') {
              actions.appendChild(
                el('button', {
                  class: 'atoms-btn ghost sm',
                  type: 'button',
                  text: (r[a.field] ? '取消' : '') + (a.label || '切换'),
                  onclick: function () {
                    var patch = {}
                    patch[a.field] = !(r[a.field] === true)
                    mutate(function () {
                      return adapter.update(c.model, r.id, patch)
                    }, '已更新')
                  },
                }),
              )
            } else if (a.kind === 'status') {
              actions.appendChild(
                el('button', {
                  class: 'atoms-btn ghost sm',
                  type: 'button',
                  text: a.label,
                  disabled: String(r[a.field]) === String(a.value),
                  onclick: function () {
                    var patch = {}
                    patch[a.field] = a.value
                    mutate(function () {
                      return adapter.update(c.model, r.id, patch)
                    }, '已更新为「' + a.value + '」')
                  },
                }),
              )
            }
          })
          row.appendChild(el('td', {}, actions))
        }
        tbody.appendChild(row)
      })
      table.appendChild(tbody)

      function mutate(fn, okText) {
        fn()
          .then(function () {
            return loadAll(true)
          })
          .then(function () {
            flash('ok', okText)
            notify('data-changed', { message: okText })
          })
          .catch(function (err) {
            reportError('数据操作', err)
            notify('error', { scope: '数据操作', message: err && err.message ? err.message : String(err) })
          })
      }

      return card(c.title || modelLabel(c.model) + '列表', table)
    }

    function renderList(c) {
      var model = modelOf(spec, c.model)
      var rows = rowsOf(c.model)
      var body = el('div', { class: 'atoms-list' })
      if (rows.length === 0) body.appendChild(el('div', { class: 'atoms-empty', text: '暂无数据' }))
      rows.forEach(function (r) {
        var titleField = model ? (model.fields || []).filter(function (f) { return f.name === c.itemTitle })[0] : null
        var subField = model && c.itemSubtitle ? (model.fields || []).filter(function (f) { return f.name === c.itemSubtitle })[0] : null
        body.appendChild(
          el('div', { class: 'item' }, [
            el('div', {}, [
              el('div', { class: 't', text: formatValue(r[c.itemTitle], titleField) }),
              c.itemSubtitle ? el('div', { class: 's', text: formatValue(r[c.itemSubtitle], subField) }) : null,
            ]),
          ]),
        )
      })
      return card(c.title || modelLabel(c.model) + '列表', body)
    }

    function renderDetail(c) {
      var model = modelOf(spec, c.model)
      var rows = rowsOf(c.model)
      var row = rows[0]
      if (!row) return card(c.title || '详情', el('div', { class: 'atoms-empty', text: '暂无可展示的记录' }))
      var grid = el('div', { class: 'atoms-kv' })
      ;(c.fields || []).forEach(function (fname) {
        var f = model ? (model.fields || []).filter(function (x) { return x.name === fname })[0] : null
        grid.appendChild(el('div', { class: 'k', text: f ? f.label : fname }))
        grid.appendChild(el('div', { text: formatValue(row[fname], f) }))
      })
      return card(c.title || '最新一条' + modelLabel(c.model), grid)
    }

    function aggregate(c) {
      var rows = rowsOf(c.model)
      var map = {}
      var order = []
      rows.forEach(function (r) {
        var key = r[c.xField] === undefined || r[c.xField] === null || r[c.xField] === '' ? '未填写' : String(r[c.xField])
        if (!(key in map)) {
          map[key] = 0
          order.push(key)
        }
        map[key] += c.aggregate === 'sum' ? toNumber(r[c.yField]) : 1
      })
      return order.slice(0, 12).map(function (k) {
        return { label: k, value: Math.round(map[k] * 100) / 100 }
      })
    }

    function renderChart(c) {
      var data = aggregate(c)
      var NS = 'http://www.w3.org/2000/svg'
      var W = 640
      var H = 260
      var PAD = 34
      var svg = doc.createElementNS(NS, 'svg')
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H)
      svg.setAttribute('class', 'atoms-chart')
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', c.title || '图表')

      if (data.length === 0) {
        return card(c.title || '图表', el('div', { class: 'atoms-empty', text: '暂无可用于绘图的数据' }))
      }

      var primary = ((spec.theme && spec.theme.primary) || '#4f46e5')
      var max = Math.max.apply(
        null,
        data.map(function (d) { return d.value }),
      )
      max = max > 0 ? max : 1

      if (c.chart === 'pie') {
        var total = data.reduce(function (a, d) { return a + d.value }, 0) || 1
        var cx = W / 2
        var cy = H / 2
        var r = Math.min(W, H) / 2 - 24
        var start = -Math.PI / 2
        var palette = ['#4f46e5', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6', '#f97316']
        data.forEach(function (d, i) {
          var angle = (d.value / total) * Math.PI * 2
          var end = start + angle
          var x1 = cx + r * Math.cos(start)
          var y1 = cy + r * Math.sin(start)
          var x2 = cx + r * Math.cos(end)
          var y2 = cy + r * Math.sin(end)
          var large = angle > Math.PI ? 1 : 0
          var path = doc.createElementNS(NS, 'path')
          path.setAttribute('d', 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x2 + ' ' + y2 + ' Z')
          path.setAttribute('fill', palette[i % palette.length])
          path.setAttribute('opacity', '0.88')
          svg.appendChild(path)
          start = end
        })
      } else {
        var innerW = W - PAD * 2
        var innerH = H - PAD * 2
        var slot = innerW / data.length
        // 坐标轴
        var axis = doc.createElementNS(NS, 'line')
        axis.setAttribute('x1', String(PAD))
        axis.setAttribute('y1', String(H - PAD))
        axis.setAttribute('x2', String(W - PAD))
        axis.setAttribute('y2', String(H - PAD))
        axis.setAttribute('stroke', '#e2e8f0')
        svg.appendChild(axis)

        var points = []
        data.forEach(function (d, i) {
          var h = (d.value / max) * innerH
          var x = PAD + slot * i + slot * 0.18
          var bw = Math.max(6, slot * 0.64)
          var y = H - PAD - h
          if (c.chart === 'line') {
            points.push([x + bw / 2, y])
          } else {
            var rect = doc.createElementNS(NS, 'rect')
            rect.setAttribute('x', String(x))
            rect.setAttribute('y', String(y))
            rect.setAttribute('width', String(bw))
            rect.setAttribute('height', String(Math.max(0, h)))
            rect.setAttribute('rx', '4')
            rect.setAttribute('fill', primary)
            rect.setAttribute('opacity', '0.88')
            svg.appendChild(rect)
          }
          var label = doc.createElementNS(NS, 'text')
          label.setAttribute('x', String(x + bw / 2))
          label.setAttribute('y', String(H - PAD + 15))
          label.setAttribute('text-anchor', 'middle')
          label.setAttribute('font-size', '11')
          label.setAttribute('fill', '#64748b')
          label.textContent = d.label.length > 6 ? d.label.slice(0, 6) + '…' : d.label
          svg.appendChild(label)

          var val = doc.createElementNS(NS, 'text')
          val.setAttribute('x', String(x + bw / 2))
          val.setAttribute('y', String(Math.max(12, y - 5)))
          val.setAttribute('text-anchor', 'middle')
          val.setAttribute('font-size', '11')
          val.setAttribute('fill', '#334155')
          val.textContent = String(d.value)
          svg.appendChild(val)
        })

        if (c.chart === 'line' && points.length > 0) {
          var poly = doc.createElementNS(NS, 'polyline')
          poly.setAttribute('points', points.map(function (p) { return p[0] + ',' + p[1] }).join(' '))
          poly.setAttribute('fill', 'none')
          poly.setAttribute('stroke', primary)
          poly.setAttribute('stroke-width', '2.5')
          svg.appendChild(poly)
          points.forEach(function (p) {
            var dot = doc.createElementNS(NS, 'circle')
            dot.setAttribute('cx', String(p[0]))
            dot.setAttribute('cy', String(p[1]))
            dot.setAttribute('r', '3.5')
            dot.setAttribute('fill', primary)
            svg.appendChild(dot)
          })
        }
      }

      return card(c.title || '汇总图表', svg)
    }

    function renderTabs(c) {
      var wrap = el('div', {})
      var key = c.id
      if (!state.activeTab[key]) state.activeTab[key] = 0
      var bar = el('div', { class: 'atoms-tabs' })
      ;(c.tabs || []).forEach(function (t, i) {
        bar.appendChild(
          el('button', {
            type: 'button',
            text: t.label,
            'aria-current': String(i === state.activeTab[key]),
            onclick: function () {
              state.activeTab[key] = i
              paint()
            },
          }),
        )
      })
      wrap.appendChild(bar)
      var active = (c.tabs || [])[state.activeTab[key]]
      if (active) {
        ;(active.components || []).forEach(function (cc) {
          wrap.appendChild(renderComponent(cc))
        })
      }
      return wrap
    }

    // ── 页面骨架 ──

    function currentPage() {
      var pages = spec.pages || []
      var found = pages.filter(function (p) {
        return p.id === state.pageId
      })[0]
      return found || pages[0] || null
    }

    function paint() {
      root.innerHTML = ''
      var page = currentPage()
      if (!page) {
        root.appendChild(el('div', { class: 'atoms-errbox', text: 'Spec 中没有可用页面' }))
        return
      }

      var nav = el('nav', { class: 'atoms-nav' })
      ;(spec.navigation || []).forEach(function (n) {
        nav.appendChild(
          el('button', {
            type: 'button',
            text: n.label,
            'aria-current': String(n.pageId === page.id),
            onclick: function () {
              state.pageId = n.pageId
              paint()
              notify('navigated', { pageId: n.pageId })
            },
          }),
        )
      })

      var head = el('header', { class: 'atoms-head' }, [
        el('h1', { class: 'atoms-title', text: (spec.meta && spec.meta.name) || '生成的应用' }),
        el('span', { class: 'atoms-badge', text: readOnly ? '只读分享' : '运行中 · 数据实时持久化' }),
        selectable
          ? el('button', {
              class: 'atoms-btn ghost sm',
              type: 'button',
              text: state.selectMode ? '退出选择' : '选择元素',
              title: '开启后点击界面上的任意组件，即可针对它提出修改',
              onclick: function () {
                state.selectMode = !state.selectMode
                paint()
              },
            })
          : null,
        nav,
      ])
      root.classList.toggle('atoms-select-mode', state.selectMode)
      root.appendChild(head)

      var body = el('main', { class: 'atoms-body' })
      if (state.flash) {
        body.appendChild(el('div', { class: 'atoms-msg ' + state.flash.kind, text: state.flash.text }))
      }
      var loadingNames = Object.keys(state.loading).filter(function (k) { return state.loading[k] })
      if (loadingNames.length > 0) {
        body.appendChild(el('div', { class: 'atoms-loading', text: '正在加载数据…' }))
      }

      var theme = spec.theme || {}
      root.style.setProperty('--atoms-primary', theme.primary || '#4f46e5')
      root.style.setProperty('--atoms-radius', theme.radius === 'sm' ? '6px' : theme.radius === 'lg' ? '16px' : '10px')
      root.style.setProperty('--atoms-gap', theme.density === 'compact' ? '10px' : theme.density === 'comfortable' ? '22px' : '16px')

      var layout = el('div', { class: 'atoms-grid ' + (page.layout === 'dashboard' ? 'cols-2' : '') })
      var byCol = page.layout === 'dashboard'
      ;(page.components || []).forEach(function (c) {
        try {
          var node = renderComponent(c)
          if (byCol && (c.type === 'stats' || c.type === 'chart')) layout.appendChild(node)
          else body.appendChild(node)
        } catch (err) {
          var box = el('div', { class: 'atoms-errbox' })
          box.appendChild(el('strong', { text: '组件渲染失败：' + c.type }))
          box.appendChild(el('div', { text: err && err.message ? err.message : String(err) }))
          body.appendChild(box)
          reportError('渲染 ' + c.type, err)
        }
      })
      if (layout.children.length > 0) body.appendChild(layout)

      if (state.errors.length > 0) {
        var errBox = el('div', { class: 'atoms-errbox' })
        errBox.appendChild(el('strong', { text: '运行时捕获到 ' + state.errors.length + ' 个问题（已如实显示，未隐藏）' }))
        state.errors.slice(-5).forEach(function (e) {
          errBox.appendChild(el('div', { text: '· ' + e.scope + '：' + e.message }))
        })
        body.appendChild(errBox)
      }

      root.appendChild(body)
      notify('height', { height: root.scrollHeight })
    }

    // 未捕获异常也要上报宿主（杜绝静默白屏）
    var onWinError = function (event) {
      reportError('全局异常', event.error || event.message)
      paint()
    }
    var onRejection = function (event) {
      reportError('未处理的 Promise 异常', event.reason)
      paint()
    }
    global.addEventListener('error', onWinError)
    global.addEventListener('unhandledrejection', onRejection)

    // ── 选中元素定向修改（Atoms 的招牌交互）──
    // 开启选择模式后，点击任意组件会把它标记回传宿主；
    // 宿主据此生成一条"针对该元素"的修改诉求，再走正常的迭代流程。
    function describeComponent(type) {
      var names = {
        form: '表单',
        table: '表格',
        list: '列表',
        detail: '详情',
        stats: '统计卡片',
        chart: '图表',
        filter: '筛选器',
        heading: '标题',
        text: '文本',
        callout: '提示',
        tabs: '标签页',
      }
      return names[type] || String(type)
    }

    function closestComponent(node) {
      var cur = node
      while (cur && cur !== root) {
        if (cur.getAttribute && cur.getAttribute('data-atoms-component')) return cur
        cur = cur.parentNode
      }
      return null
    }

    root.addEventListener(
      'click',
      function (event) {
        if (!state.selectMode) return
        var hit = closestComponent(event.target)
        if (!hit) return
        // 选择模式下拦截点击，避免误触发表单提交/删除等真实操作
        event.preventDefault()
        event.stopPropagation()
        var page = currentPage()
        notify('element-selected', {
          componentId: hit.getAttribute('data-atoms-component'),
          componentType: hit.getAttribute('data-atoms-type'),
          pageId: state.pageId,
          pageTitle: page ? page.title : '',
          summary: describeComponent(hit.getAttribute('data-atoms-type')),
        })
      },
      true,
    )

    // 宿主 → 预览 的消息协议
    var onMessage = function (event) {
      var data = event.data || {}
      if (data.source !== 'atoms-host') return
      if (data.type === 'reload') loadAll(true)
      if (data.type === 'goto' && data.pageId) {
        state.pageId = data.pageId
        paint()
      }
    }
    global.addEventListener('message', onMessage)

    state.pageId = (spec.pages && spec.pages[0] && spec.pages[0].id) || null
    loadAll(true).then(function () {
      notify('ready', { version: VERSION, pages: (spec.pages || []).length })
    })

    return {
      version: VERSION,
      refresh: function () {
        return loadAll(true)
      },
      getErrors: function () {
        return state.errors.slice()
      },
      destroy: function () {
        global.removeEventListener('error', onWinError)
        global.removeEventListener('unhandledrejection', onRejection)
        global.removeEventListener('message', onMessage)
      },
    }
  }

  global.AtomsRuntime = {
    version: VERSION,
    supportedComponents: SUPPORTED,
    renderApp: renderApp,
    createHttpAdapter: createHttpAdapter,
    createLocalAdapter: createLocalAdapter,
  }
})(typeof window !== 'undefined' ? window : globalThis)
