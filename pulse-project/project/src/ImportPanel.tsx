import { useEffect, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import './import.css'
import { A_ON, V_STOP, label, type Analysis, type Row, type Series } from './analysis'
import { buildSeries, openSource, type Source } from './loader'

const FIELDS: [string, string][] = [['time', '時刻'], ['speed', '速度'], ['hr', '心拍'], ['ax', '加速度X（任意）'], ['ay', '加速度Y（任意）'], ['az', '加速度Z（任意）']]
const GUESS: Record<string, RegExp> = {
  time: /time|時刻|日時|date/i, speed: /speed|velocity|速度|spd/i, hr: /^hr|heart|心拍|bpm/i,
  ax: /acc.*x|^ax|^x$|加速度.*x/i, ay: /acc.*y|^ay|^y$|加速度.*y/i, az: /acc.*z|^az|^z$|加速度.*z/i,
}
const f1 = (v: number, d = 2) => (isFinite(v) ? v.toFixed(d) : '–')

function save(blob: Blob, name: string) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
function toCsv(rows: Row[]) {
  const keys = Object.keys(rows[0] ?? {})
  return '\ufeff' + [keys.join(','), ...rows.map((r) => keys.map((k) => (typeof r[k] === 'number' ? +(r[k] as number).toFixed(4) : r[k])).join(','))].join('\n')
}

// 2章: 秒ごとに色分けした心拍グラフ
function SecondChart({ s }: { s: Series }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current; if (!cv) return
    const g = cv.getContext('2d')!, W = cv.width, H = cv.height, L = 50, B = 30
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H)
    const hv = Array.from(s.hr).filter(isFinite); if (!hv.length) return
    const lo = Math.floor(Math.min(...hv) / 10) * 10, hi = Math.ceil(Math.max(...hv) / 10) * 10 || lo + 10
    const X = (i: number) => L + (i / s.N) * (W - L - 10), Y = (v: number) => H - B - ((v - lo) / (hi - lo)) * (H - B - 24)
    g.strokeStyle = '#e3eae8'; g.fillStyle = '#71838c'; g.font = '12px sans-serif'
    for (let v = lo; v <= hi; v += 10) { g.beginPath(); g.moveTo(L, Y(v)); g.lineTo(W - 10, Y(v)); g.stroke(); g.fillText(String(v), 14, Y(v) + 4) }
    for (let m = 0; m <= s.N / 60; m += 10) g.fillText(m + '分', X(m * 60) - 8, H - 10)
    g.lineWidth = 2
    for (let i = 1; i < s.N; i++) {
      if (!isFinite(s.hr[i]) || !isFinite(s.hr[i - 1])) continue
      const a = s.acc[i], t = Math.min(Math.abs(a) / 3, 1)
      g.strokeStyle = s.speed[i] < V_STOP ? '#000' : a >= A_ON ? `rgb(${255 - 55 * t},${200 * (1 - t)},${200 * (1 - t)})` : a <= -A_ON ? `rgb(${200 * (1 - t)},${200 * (1 - t)},${255 - 55 * t})` : '#bbb'
      g.beginPath(); g.moveTo(X(i - 1), Y(s.hr[i - 1])); g.lineTo(X(i), Y(s.hr[i])); g.stroke()
    }
    g.fillStyle = '#21313b'; g.fillText('赤=加速 / 青=減速 / 黒=停止 / 灰=一定速度', L + 10, 14)
  }, [s])
  return (
    <>
      <canvas ref={ref} width={1100} height={360} className="imp-canvas" />
      <button className="export-button" onClick={() => ref.current?.toBlob((b) => b && save(b, `${s.name}_hr_color.png`))}>PNGを保存</button>
    </>
  )
}

interface Props {
  series: Series[]; onSeries: (s: Series[]) => void
  analysis: Analysis | { err: string }
  win: number; onWin: (w: 5 | 10) => void
  thr: number; onThr: (v: number) => void
  lam: number; onLam: (v: number) => void
}

export default function ImportPanel({ series, onSeries, analysis, win, onWin, thr, onThr, lam, onLam }: Props) {
  const [srcs, setSrcs] = useState<Source[]>([])
  const [names, setNames] = useState<Record<string, string>>({})
  const [enc, setEnc] = useState('UTF-8')
  const [unit, setUnit] = useState('auto')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [gi, setGi] = useState(0)

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setStatus('読み込み中…')
    try {
      const list: Source[] = []
      for (const f of Array.from(files)) list.push(await openSource(f, enc))
      const h = list[0].header, n: Record<string, string> = {}
      FIELDS.forEach(([k]) => { n[k] = h.find((c) => GUESS[k].test(c)) ?? '' })
      setSrcs(list); setNames(n)
      setStatus(`${list.length}ファイルを読み込みました。列を確認して「分析する」を押してください。`)
    } catch (e) { setStatus('⚠ ' + (e as Error).message) }
  }
  const run = async () => {
    setBusy(true)
    try {
      const out: Series[] = []
      for (const [i, s] of srcs.entries()) { setStatus(`分析中 ${i + 1}/${srcs.length}: ${s.file.name}`); out.push(await buildSeries(s, names, unit)) }
      onSeries(out); setGi(0)
      setStatus(`完了。速度の単位: ${out.map((o) => o.unit).join(', ')}。区間数が少ないうちは目安です。`)
    } catch (e) { setStatus('⚠ ' + (e as Error).message) }
    setBusy(false)
  }

  const ok = 'err' in analysis ? null : analysis
  const reportXlsx = () => {
    if (!ok) return
    const wb = XLSX.utils.book_new(), add = (n: string, a: object[]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(a), n)
    add(`区間データ${ok.win}分`, ok.rows)
    add('特徴量ランキング', ok.rk.map((r) => ({ 特徴量: label(r.key), k: r.k, 範囲下: r.lo, 範囲上: r.hi, R2: r.r2, 検証MAE: r.mae, 改善: r.gain, 重なり: r.overlap, 判定: r.verdict })))
    add('リッジ式', [{ b0: ok.model.b0, c_始めの心拍: ok.model.c, ...Object.fromEntries(ok.keys.flatMap((k, j) => [[`k_${k}`, ok.model.k[j]], [`w_${k}`, ok.model.w[j]]])) }])
    add('検証', [{ 方法: ok.ev.mode, 区間数: ok.ev.n, 変わらない予想MAE: ok.ev.base, リッジ検証MAE: ok.ev.stack, リッジ作成データMAE: ok.inMae }])
    XLSX.writeFile(wb, `hr_report_${ok.win}min.xlsx`)
  }

  return (
    <div className="imp">
      <section className="panel imp-block">
        <div className="section-kicker">01 / IMPORT</div><h2>データの取り込み</h2>
        <p className="panel-intro">CSV / xlsx（複数可）。CSVは約2GB、xlsxは150MBまで。データはブラウザ内だけで処理され、外部には送られません。</p>
        <div className="imp-row">
          <input type="file" accept=".csv,.xlsx,.xls" multiple onChange={(e) => onFiles(e.target.files)} />
          <label>文字コード <select value={enc} onChange={(e) => setEnc(e.target.value)}><option>UTF-8</option><option>Shift_JIS</option></select></label>
          <label>速度の単位 <select value={unit} onChange={(e) => setUnit(e.target.value)}><option value="auto">自動判定</option><option value="kmh">km/h</option><option value="ms">m/s</option></select></label>
        </div>
        {srcs.length > 0 && <div className="imp-row">{FIELDS.map(([k, l]) => (
          <label key={k}>{l} <select value={names[k] ?? ''} onChange={(e) => setNames({ ...names, [k]: e.target.value })}><option value="">（なし）</option>{srcs[0].header.map((c) => <option key={c}>{c}</option>)}</select></label>
        ))}</div>}
        <div className="imp-row">
          <label>衝撃のしきい値（加速度の大きさ） <input type="number" value={thr} step={0.5} onChange={(e) => onThr(+e.target.value)} /></label>
          <label>リッジの強さ λ <input type="number" value={lam} step={0.5} min={0} onChange={(e) => onLam(+e.target.value)} /></label>
          <label>区切り幅 <select value={win} onChange={(e) => onWin(+e.target.value as 5 | 10)}><option value={5}>5分</option><option value={10}>10分</option></select></label>
          <button className="export-button" disabled={!srcs.length || busy} onClick={run}>分析する</button>
        </div>
        <p className="imp-status">{status}</p>
      </section>

      {series.length === 0 && <section className="panel imp-block"><h2>式を確かめる流れ</h2>
        <ol className="imp-list">
          <li>できるだけ多くの試合・選手のデータを取り込む（1試合だけだと検証が「時間ブロック」になり、目安にとどまります）。</li>
          <li>特徴量ランキングで、◎（範囲が0をまたがず、「心拍は変わらない」予想より誤差が小さい）の動きを探す。</li>
          <li>「他との重なり」が大きい特徴量は同じことを測っているので、段階2のリッジで調整される。</li>
          <li>検証MAEが「変わらない」予想に勝てなければ、その式は採用しない。</li>
          <li>試合を足して作り直し、◎の顔ぶれが安定するか確認する。</li>
        </ol></section>}

      {'err' in analysis && series.length > 0 && <section className="panel imp-block imp-warn">{analysis.err}</section>}

      {ok && <>
        <section className="panel imp-block">
          <div className="section-kicker">02 / FEATURES</div><h2>このデータで効いている特徴量</h2>
          <div className="imp-note">
            ◎ 有望: {ok.rk.filter((r) => r.verdict.startsWith('◎')).map((r) => label(r.key)).join('、') || 'なし'}<br />
            ○ 可能性あり: {ok.rk.filter((r) => r.verdict.startsWith('○')).map((r) => label(r.key)).join('、') || 'なし'}<br />
            区間数 {ok.rows.length}・ファイル数 {series.length}。{ok.rows.length < 30 && <b>区間数が少ないため目安です。</b>}
          </div>
          <div className="table-scroll"><table><thead><tr><th>特徴量</th><th>k（拍/単位）</th><th>95%範囲</th><th>R²</th><th>検証MAE</th><th>改善(拍)</th><th>他との重なり</th><th>判定</th></tr></thead>
            <tbody>{ok.rk.map((r) => <tr key={r.key}><td><strong>{label(r.key)}</strong></td><td>{f1(r.k, 3)}</td><td>{f1(r.lo, 3)}〜{f1(r.hi, 3)}</td><td>{f1(r.r2)}</td><td>{f1(r.mae)}</td><td className={r.gain > 0 ? 'cell-up' : 'cell-down'}>{f1(r.gain)}</td><td>{f1(r.overlap)}</td><td>{r.verdict}</td></tr>)}</tbody></table></div>
          <p className="panel-intro">改善＝「心拍は変わらない」予想のMAE − その特徴量だけで当てた検証MAE。範囲が0をまたがなければ効き目がはっきり。重なりが0.8超なら同じことを測っている可能性があります。</p>
        </section>

        <section className="panel imp-block">
          <div className="section-kicker">03 / RIDGE</div><h2>段階2: リッジ回帰でまとめた式</h2>
          <div className="table-scroll"><table><thead><tr><th>項目</th><th>k（段階1）</th><th>95%範囲</th><th>w（採用度）</th></tr></thead>
            <tbody>{ok.keys.map((k, j) => <tr key={k}><td><strong>{label(k)}</strong></td><td>{f1(ok.model.k[j], 3)}</td><td>{f1(ok.cis[k][0], 3)}〜{f1(ok.cis[k][1], 3)}</td><td>{f1(ok.model.w[j])}</td></tr>)}</tbody></table></div>
          <p className="panel-intro">心拍の変化 = {f1(ok.model.b0)} + Σ w·k·x + ({f1(ok.model.c, 3)})×始めの心拍　（c がマイナス＝高い心拍ほど下がる）</p>
        </section>

        <section className="panel imp-block">
          <div className="section-kicker">04 / VALIDATION</div><h2>検証（{ok.ev.mode}・{ok.ev.n}区間）</h2>
          <div className="table-scroll"><table><thead><tr><th>方法</th><th>MAE（拍）</th></tr></thead><tbody>
            <tr><td>「心拍は変わらない」予想</td><td>{f1(ok.ev.base)}</td></tr>
            <tr><td>リッジの式（初見で検証）</td><td>{f1(ok.ev.stack)}</td></tr>
            <tr><td>リッジの式（作った同じデータ・参考）</td><td>{f1(ok.inMae)}</td></tr></tbody></table></div>
          <div className={'imp-note' + (ok.ev.stack < ok.ev.base ? '' : ' imp-warn')}>
            {ok.ev.stack < ok.ev.base ? '式は「変わらない」予想より誤差が小さくなりました。' : '式は「変わらない」予想を上回れていません。このデータでは式に意味があるとは言えません。'}
            {ok.ev.stack - ok.inMae > 3 && '　作った場合と検証の差が大きく、合わせすぎ（過学習）の疑いがあります。'}
          </div>
        </section>

        <section className="panel imp-block">
          <div className="section-kicker">05 / DOWNLOAD</div><h2>色分け心拍グラフとダウンロード</h2>
          <div className="imp-row">
            <select value={gi} onChange={(e) => setGi(+e.target.value)}>{series.map((s, i) => <option key={s.name} value={i}>{s.name}</option>)}</select>
            <button className="export-button" onClick={reportXlsx}>レポート(xlsx)</button>
            {series.map((s) => <button key={s.name} className="export-button" onClick={() => save(new Blob([toCsv(ok.rows.filter((r) => r.file === s.name))], { type: 'text/csv' }), `${s.name}_${ok.win}min.csv`)}>{s.name} CSV</button>)}
          </div>
          {series[gi] && <SecondChart s={series[gi]} />}
        </section>
      </>}
    </div>
  )
}
