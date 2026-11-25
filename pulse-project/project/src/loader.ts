import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { Collector, type ColumnMap, type Series } from './analysis'

export const MAX_CSV = 2 * 1024 ** 3 // CSVは分割読み込みなので約2GBまで
export const MAX_XLSX = 150 * 1024 ** 2 // xlsxは全体をメモリに展開するため150MBまで

export interface Source { file: File; header: string[]; each: (cb: (row: unknown[]) => void) => Promise<void> }

export async function openSource(file: File, encoding: string): Promise<Source> {
  const isX = /\.xlsx?$/i.test(file.name)
  if (file.size > (isX ? MAX_XLSX : MAX_CSV)) throw new Error(`${file.name}: サイズ超過（${isX ? 'xlsx は150MB' : 'CSV は2GB'}まで）`)
  if (isX) {
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true })
    return { file, header: (rows[0] ?? []).map(String), each: async (cb) => { for (let i = 1; i < rows.length; i++) cb(rows[i]) } }
  }
  const head = await new Promise<unknown[][]>((res, rej) =>
    Papa.parse<unknown[]>(file, { preview: 2, encoding, skipEmptyLines: true, complete: (r) => res(r.data), error: (e) => rej(e) }))
  return {
    file, header: (head[0] ?? []).map(String),
    each: (cb) => new Promise<void>((res, rej) => {
      let first = true
      Papa.parse<unknown[]>(file, {
        encoding, skipEmptyLines: true, chunkSize: 1 << 23, error: (e: Error) => rej(e), complete: () => res(),
        chunk: (r: Papa.ParseResult<unknown[]>) => { for (const row of r.data) { if (first) { first = false; continue } cb(row) } },
      })
    }),
  }
}

export async function buildSeries(src: Source, names: Record<string, string>, unit: string): Promise<Series> {
  const ix = (k: string) => (names[k] ? src.header.indexOf(names[k]) : -1)
  const m: ColumnMap = { time: ix('time'), speed: ix('speed'), hr: ix('hr'), ax: ix('ax'), ay: ix('ay'), az: ix('az'), unit }
  if (m.time < 0 || m.speed < 0 || m.hr < 0) throw new Error(`${src.file.name}: 時刻・速度・心拍の列が見つかりません`)
  const col = new Collector(m)
  await src.each((r) => col.add(r))
  return col.finish(src.file.name.replace(/\.[^.]+$/, ''))
}
