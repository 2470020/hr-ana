// 心拍応答モデルの計算（分析方法の説明.pdf の 4〜6章）
export const A_ON = 0.5
export const V_STOP = 0.5 // m/s（約1.8 km/h）
export const EDGE = 5

export interface Row {
  win: string
  file: string
  sec: number
  hr0: number
  hr1: number
  dhr: number
  pred: number
  resid: number
  [k: string]: number | string
}
export interface Bout { t: number; kind: '加速' | '減速'; d: number; dv: number }
export interface Series {
  name: string; N: number; unit: string; hasAcc: boolean
  speed: Float64Array; hr: Float64Array; pl: Float64Array; mx: Float64Array; acc: Float64Array
  bouts: Bout[]
}
export interface ColumnMap { time: number; speed: number; hr: number; ax: number; ay: number; az: number; unit: string }

export const FEATS = [
  { k: 'x1_tv', l: 'x1 加速（時間×変化量）' }, { k: 'x1_t', l: 'x1 加速（時間のみ）' }, { k: 'x1_v', l: 'x1 加速（変化量のみ）' },
  { k: 'x2_tv', l: 'x2 減速（時間×変化量）' }, { k: 'x2_t', l: 'x2 減速（時間のみ）' }, { k: 'x2_v', l: 'x2 減速（変化量のみ）' },
  { k: 'x3', l: 'x3 体の揺れ（PlayerLoad風）' }, { k: 'x4', l: 'x4 衝撃（回数）' }, { k: 'x5', l: 'x5 停止（秒）' },
]
export const STACK = ['x1_tv', 'x2_tv', 'x3', 'x4', 'x5']
export const label = (k: string) => FEATS.find((f) => f.k === k)?.l ?? k

const sum = (a: number[]) => a.reduce((x, y) => x + y, 0)
const mean = (a: number[]) => sum(a) / a.length
const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return isFinite(n) ? n : NaN }
const g = (r: Row, k: string) => r[k] as number

export function parseTime(v: unknown): number | null {
  if (v instanceof Date) return v.getTime() / 1000
  if (v == null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!isNaN(n)) return n > 1e11 ? n / 1000 : n
  const d = Date.parse(String(v).replace(/\//g, '-'))
  return isNaN(d) ? null : d / 1000
}

interface Bucket { sp: number; ns: number; hr: number; nh: number; pl: number; mx: number }

// 生データを1秒ごとにまとめる（行ごとに add、最後に finish）
export class Collector {
  m: ColumnMap
  t0: number | null = null
  b: Bucket[] = []
  p: number[] | null = null
  constructor(m: ColumnMap) { this.m = m }
  add(r: unknown[]) {
    const m = this.m
    const t = parseTime(r[m.time])
    if (t == null) return
    if (this.t0 == null) this.t0 = t
    const s = Math.floor(t - this.t0)
    if (s < 0 || s > 172800) return
    const b = this.b[s] || (this.b[s] = { sp: 0, ns: 0, hr: 0, nh: 0, pl: 0, mx: 0 })
    const sp = num(r[m.speed]); if (!isNaN(sp)) { b.sp += sp; b.ns++ }
    const hr = num(r[m.hr]); if (hr >= 30 && hr <= 230) { b.hr += hr; b.nh++ }
    if (m.ax >= 0 && m.ay >= 0 && m.az >= 0) {
      const a = [num(r[m.ax]), num(r[m.ay]), num(r[m.az])]
      if (a.every(isFinite)) {
        b.mx = Math.max(b.mx, Math.hypot(a[0], a[1], a[2]))
        if (this.p) b.pl += Math.hypot(a[0] - this.p[0], a[1] - this.p[1], a[2] - this.p[2])
        this.p = a
      }
    }
  }
  finish(name: string): Series {
    const N = this.b.length, mk = () => new Float64Array(N)
    const speed = mk().fill(NaN), hr = mk().fill(NaN), pl = mk(), mx = mk(), acc = mk().fill(NaN)
    this.b.forEach((b, i) => { if (!b) return; if (b.ns) speed[i] = b.sp / b.ns; if (b.nh) hr[i] = b.hr / b.nh; pl[i] = b.pl; mx[i] = b.mx })
    const sp = Array.from(speed).filter(isFinite).sort((a, b) => a - b)
    const p99 = sp[Math.floor(sp.length * 0.99)] || 0
    const unit = this.m.unit === 'auto' ? (p99 > 12 ? 'kmh' : 'ms') : this.m.unit
    if (unit === 'kmh') for (let i = 0; i < N; i++) speed[i] /= 3.6
    for (let i = 1; i < N; i++) acc[i] = speed[i] - speed[i - 1]
    const s: Series = { name, N, unit, hasAcc: this.m.ax >= 0 && this.m.ay >= 0 && this.m.az >= 0, speed, hr, pl, mx, acc, bouts: [] }
    s.bouts = findBouts(s)
    return s
  }
}

// 加速・減速を1回ずつ取り出す（hr_window_bouts.py と同じ）
export function findBouts(s: Series): Bout[] {
  const out: Bout[] = []
  const kinds: ['加速' | '減速', (a: number) => boolean][] = [['加速', (a) => a >= A_ON], ['減速', (a) => a <= -A_ON]]
  for (const [kind, ok] of kinds) {
    let a0 = -1
    for (let i = 0; i <= s.N; i++) {
      const on = i < s.N && ok(s.acc[i])
      if (on && a0 < 0) a0 = i
      else if (!on && a0 >= 0) {
        const d = i - a0, v0 = a0 > 0 ? s.speed[a0 - 1] : s.speed[a0], dv = Math.abs(s.speed[i - 1] - v0)
        if (d >= 1 && isFinite(dv)) out.push({ t: a0, kind, d, dv })
        a0 = -1
      }
    }
  }
  return out
}

export function windows(s: Series, min: number, thr: number): Row[] {
  const W = min * 60, rows: Row[] = []
  for (let st = 0; st < s.N; st += W) {
    const e = Math.min(st + W, s.N)
    if (e - st < 2 * EDGE) continue
    const r: Row = { win: `${st / 60}–${st / 60 + min}分`, file: s.name, sec: e - st, hr0: NaN, hr1: NaN, dhr: NaN, pred: NaN, resid: NaN }
    FEATS.forEach((x) => { r[x.k] = 0 })
    for (const b of s.bouts) if (b.t >= st && b.t < e) {
      const p = b.kind === '加速' ? 'x1' : 'x2'
      r[p + '_t'] = g(r, p + '_t') + b.d; r[p + '_v'] = g(r, p + '_v') + b.dv; r[p + '_tv'] = g(r, p + '_tv') + b.d * b.dv
    }
    const hrs: number[] = []
    for (let i = st; i < e; i++) {
      r.x3 = g(r, 'x3') + s.pl[i]
      if (s.hasAcc && s.mx[i] >= thr) r.x4 = g(r, 'x4') + 1
      if (s.speed[i] < V_STOP) r.x5 = g(r, 'x5') + 1
      if (isFinite(s.hr[i])) hrs.push(s.hr[i])
    }
    if (hrs.length >= 2 * EDGE) { r.hr0 = mean(hrs.slice(0, EDGE)); r.hr1 = mean(hrs.slice(-EDGE)); r.dhr = r.hr1 - r.hr0 }
    rows.push(r)
  }
  return rows
}

const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
export const kOf = (rows: Row[], key: string) => { let a = 0, b = 0; for (const r of rows) { a += g(r, key) * r.dhr; b += g(r, key) ** 2 } return b > 0 ? a / b : 0 }
export function boot(rows: Row[], key: string, B = 1000): [number, number] {
  const rnd = rng(1), n = rows.length, ks: number[] = []
  for (let b = 0; b < B; b++) { let a = 0, c = 0; for (let i = 0; i < n; i++) { const r = rows[(rnd() * n) | 0]; a += g(r, key) * r.dhr; c += g(r, key) ** 2 } ks.push(c > 0 ? a / c : 0) }
  ks.sort((x, y) => x - y)
  return [ks[(B * 0.025) | 0], ks[(B * 0.975) | 0]]
}
export function corr(x: number[], y: number[]) {
  const mx = mean(x), my = mean(y); let a = 0, b = 0, c = 0
  for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2 }
  return b > 0 && c > 0 ? a / Math.sqrt(b * c) : 0
}
function solve(A: number[][], b: number[]) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]])
  for (let i = 0; i < n; i++) {
    let p = i
    for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j
    ;[M[i], M[p]] = [M[p], M[i]]
    for (let j = i + 1; j < n; j++) { const q = M[j][i] / (M[i][i] || 1e-12); for (let k = i; k <= n; k++) M[j][k] -= q * M[i][k] }
  }
  const x = Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) { let s = M[i][n]; for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]; x[i] = s / (M[i][i] || 1e-12) }
  return x
}

export interface Stack { keys: string[]; k: number[]; w: number[]; c: number; b0: number; predict: (r: Row) => number }
// 段階2: z = k·x を材料にリッジ回帰（始めの心拍 c の項つき）
export function trainStack(rows: Row[], keys: string[], lam: number): Stack {
  const k = keys.map((q) => kOf(rows, q)), n = rows.length, p = keys.length + 1
  const Z = rows.map((r) => [...keys.map((q, j) => k[j] * g(r, q)), r.hr0])
  const mu = Array.from({ length: p }, (_, j) => mean(Z.map((z) => z[j])))
  const sd = Array.from({ length: p }, (_, j) => Math.sqrt(mean(Z.map((z) => (z[j] - mu[j]) ** 2))) || 1)
  const yb = mean(rows.map((r) => r.dhr))
  const S = Z.map((z) => z.map((v, j) => (v - mu[j]) / sd[j]))
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => sum(S.map((s) => s[i] * s[j])) / n + (i === j ? lam : 0)))
  const bv = Array.from({ length: p }, (_, i) => sum(S.map((s, t) => s[i] * (rows[t].dhr - yb))) / n)
  const coef = solve(A, bv).map((v, j) => v / sd[j])
  const b0 = yb - sum(coef.map((c, j) => c * mu[j]))
  const w = coef.slice(0, -1), c = coef[p - 1]
  return { keys, k, w, c, b0, predict: (r) => b0 + sum(keys.map((q, j) => w[j] * k[j] * g(r, q))) + c * r.hr0 }
}

export interface Eval { mode: string; n: number; stack: number; base: number; single: Record<string, number> }
// 検証: 複数試合なら1試合抜き、1試合だけなら時間ブロック5分割
export function evaluate(rows: Row[], keys: string[], cands: string[], lam: number): Eval {
  const ids = [...new Set(rows.map((r) => r.file))], multi = ids.length >= 2
  const F = multi ? rows.map((r) => ids.indexOf(r.file)) : rows.map((_, i) => Math.floor((i * 5) / rows.length))
  const nf = Math.max(...F) + 1, eS: number[] = [], eB: number[] = []
  const eC: Record<string, number[]> = Object.fromEntries(cands.map((c) => [c, []]))
  for (let f = 0; f < nf; f++) {
    const tr = rows.filter((_, i) => F[i] !== f), te = rows.filter((_, i) => F[i] === f)
    if (tr.length < 8 || !te.length) continue
    const m = trainStack(tr, keys, lam)
    for (const r of te) { eS.push(Math.abs(r.dhr - m.predict(r))); eB.push(Math.abs(r.dhr)) }
    for (const c of cands) { const k = kOf(tr, c); for (const r of te) eC[c].push(Math.abs(r.dhr - k * g(r, c))) }
  }
  const mae = (a: number[]) => (a.length ? mean(a) : NaN)
  return { mode: multi ? '1試合抜き' : '時間ブロック5分割（1試合のみ）', n: eS.length, stack: mae(eS), base: mae(eB), single: Object.fromEntries(cands.map((c) => [c, mae(eC[c])])) }
}

export interface Rank { key: string; k: number; lo: number; hi: number; r2: number; mae: number; gain: number; overlap: number; verdict: string }
export function rank(rows: Row[], cands: string[], ev: Eval): Rank[] {
  const y = rows.map((r) => r.dhr), yb = mean(y), sst = sum(y.map((v) => (v - yb) ** 2))
  return cands.map((c) => {
    const k = kOf(rows, c), ci = boot(rows, c), sse = sum(rows.map((r) => (r.dhr - k * g(r, c)) ** 2))
    const gain = ev.base - ev.single[c], excl0 = ci[0] * ci[1] > 0
    const overlap = Math.max(0, ...cands.filter((o) => o.slice(0, 2) !== c.slice(0, 2)).map((o) => Math.abs(corr(rows.map((r) => g(r, c)), rows.map((r) => g(r, o))))))
    const verdict = gain > 0 && excl0 ? '◎ 有望' : gain > 0 || excl0 ? '○ 可能性あり' : '△ 弱い'
    return { key: c, k, lo: ci[0], hi: ci[1], r2: sst > 0 ? 1 - sse / sst : NaN, mae: ev.single[c], gain, overlap, verdict }
  }).sort((a, b) => (isNaN(b.gain) ? -1e9 : b.gain) - (isNaN(a.gain) ? -1e9 : a.gain))
}

export interface Analysis {
  win: number; rows: Row[]; cands: string[]; keys: string[]; model: Stack; ev: Eval; rk: Rank[]
  cis: Record<string, [number, number]>; inMae: number; contrib: Record<string, number>
}
export function analyze(series: Series[], win: number, thr: number, lam: number): Analysis | { err: string } {
  const rows = series.flatMap((s) => windows(s, win, thr)).filter((r) => isFinite(r.dhr))
  if (rows.length < 8) return { err: `心拍が取れた区間が ${rows.length} 件しかありません（8件以上必要）。区切り幅を短くするか、ファイルを増やしてください。` }
  const cands = FEATS.map((x) => x.k).filter((k) => new Set(rows.map((r) => r[k])).size > 1)
  const keys = STACK.filter((k) => cands.includes(k))
  const model = trainStack(rows, keys, lam), ev = evaluate(rows, keys, cands, lam), rk = rank(rows, cands, ev)
  rows.forEach((r) => { r.pred = r.hr0 + model.predict(r); r.resid = r.dhr - model.predict(r) })
  const cis = Object.fromEntries(keys.map((k) => [k, boot(rows, k)])) as Record<string, [number, number]>
  const contrib = Object.fromEntries(keys.map((k, j) => [k, model.k[j] * mean(rows.map((r) => g(r, k)))]))
  const inMae = mean(rows.map((r) => Math.abs(r.resid)))
  return { win, rows, cands, keys, model, ev, rk, cis, inMae, contrib }
}
