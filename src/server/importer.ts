/**
 * 단어장 임포터. 원본 엑셀은 수정하지 않고 읽기만 한다.
 * 매핑은 config/wordbooks/<code>.json 에 둔다 (시트 이름 패턴, 헤더 행, 블록별 열 문자).
 * 같은 파일을 다시 임포트하면 (Unit, 번호) 기준으로 갱신만 하고 행을 새로 만들지 않는다.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db, Queryable } from './db';
import { cleanDisplay, detectKind, englishKey, senseKeys } from './normalize';
import { OptionBuilder, type WordRec } from './options';

export interface BlockMap {
  name: string;
  no: string;
  english: string;
  pos: string;
  meaning: string;
  confusables?: string;
}

export interface WordbookConfig {
  code: string;
  title: string;
  isSample?: boolean;
  answerKeyFile: string;
  crossCheckFile?: string | null;
  sheetPattern: string;
  unitCodeTemplate: string;
  unitLabelTemplate: string;
  headerRow: number;
  firstDataRow: number;
  blocks: BlockMap[];
  expectedHeader: string[];
  /** 동의·유사 그룹 파일 (같은 그룹 표현은 한 문항의 보기로 함께 나오지 않음) */
  synonymGroupsFile?: string | null;
}

interface SynonymGroups {
  groups: Array<{ name: string; items: string[] }>;
}

export type Severity = 'error' | 'warning' | 'info';
export interface ImportIssue {
  severity: Severity;
  type:
    | 'sheet_name_unmatched'
    | 'header_mismatch'
    | 'missing_english'
    | 'missing_meaning'
    | 'bad_number'
    | 'duplicate_number'
    | 'duplicate_in_unit'
    | 'duplicate_across_units'
    | 'same_english_different_meaning'
    | 'same_meaning_different_english'
    | 'whitespace_trimmed'
    | 'crosscheck_mismatch'
    | 'crosscheck_missing'
    | 'synonym_group_unmatched'
    | 'not_testable';
  file: string;
  sheet: string;
  cell: string;
  message: string;
  english?: string;
  meaning?: string;
}

export interface ParsedWord {
  unitCode: string;
  unitLabel: string;
  unitOrdinal: number;
  sheet: string;
  itemNo: number;
  english: string;
  englishKey: string;
  pos: string | null;
  meaning: string;
  senses: string[];
  kind: 'word' | 'phrase' | 'sentence';
  confusables: string[];
  conflicts: string[];
  sourceCell: string;
  contentHash: string;
  status: 'active' | 'needs_review';
  statusReason: string | null;
}

export interface ParsedUnit {
  code: string;
  label: string;
  ordinal: number;
  sheet: string;
  read: number;
  imported: number;
  duplicates: number;
  excluded: number;
  needsReview: number;
}

export interface ImportReport {
  wordbook: string;
  title: string;
  file: string;
  sha256: string;
  ranAt: string;
  dryRun: boolean;
  totals: {
    sheets: number;
    unitsRecognized: number;
    read: number; // 원본에서 값이 있는 칸 묶음(번호/단어/품사/뜻) 수
    imported: number; // DB 반영(활성) 수
    duplicates: number; // 같은 Unit 안 완전 중복 → 1개만 반영
    excluded: number; // 반영하지 않음 (필수값 누락 등)
    needsReview: number; // 반영하되 출제 제외, 교사 확인 필요
    crossUnitRepeats: number; // 다른 Unit 에 같은 영어+뜻이 다시 나옴 (각 Unit 에 유지, 한 회차에서는 1번만 출제)
    testable: number; // 출제 점검 통과(한 방향 이상)
    notTestable: number;
    inserted?: number;
    updated?: number;
    unchanged?: number;
    retired?: number;
  };
  units: ParsedUnit[];
  issues: ImportIssue[];
  crossCheck: { file: string | null; compared: number; mismatches: number; note: string };
  synonymGroups: number;
}

function colIndex(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function fillTemplate(t: string, ch: number, day: number): string {
  return t
    .replace('{ch2}', String(ch).padStart(2, '0'))
    .replace('{ch}', String(ch))
    .replace('{day}', String(day));
}

type SheetLike = { name: string; cell: (row: number, col: string) => string; rowCount: number };

async function loadWorkbook(file: string): Promise<SheetLike[]> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  return wb.worksheets.map((ws) => ({
    name: ws.name,
    rowCount: ws.rowCount,
    cell: (row: number, col: string) => {
      const c = ws.getRow(row).getCell(colIndex(col));
      const v = c.value as any;
      if (v == null) return '';
      if (typeof v === 'object' && Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join('');
      if (typeof v === 'object' && 'result' in v) return String(v.result ?? '');
      if (typeof v === 'object' && 'text' in v) return String(v.text ?? '');
      return String(v);
    },
  }));
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 원본 파싱 + 검증 (DB 접근 없음) */
export async function parseWordbook(cfg: WordbookConfig, root = process.cwd()) {
  const file = path.resolve(root, cfg.answerKeyFile);
  const fileLabel = path.basename(file);
  const sheets = await loadWorkbook(file);
  const re = new RegExp(cfg.sheetPattern);
  const issues: ImportIssue[] = [];
  const recognized: Array<{ sheet: SheetLike; ch: number; day: number }> = [];

  for (const s of sheets) {
    const m = re.exec(s.name);
    if (!m) {
      issues.push({ severity: 'error', type: 'sheet_name_unmatched', file: fileLabel, sheet: s.name, cell: '-', message: `시트 이름이 Unit 패턴(${cfg.sheetPattern})과 맞지 않아 건너뜀` });
      continue;
    }
    recognized.push({ sheet: s, ch: Number(m[1]), day: Number(m[2]) });
  }
  recognized.sort((a, b) => a.ch - b.ch || a.day - b.day);

  const words: ParsedWord[] = [];
  const units: ParsedUnit[] = [];
  let trimmed = 0;

  recognized.forEach(({ sheet, ch, day }, idx) => {
    const unit: ParsedUnit = {
      code: fillTemplate(cfg.unitCodeTemplate, ch, day),
      label: fillTemplate(cfg.unitLabelTemplate, ch, day),
      ordinal: idx + 1,
      sheet: sheet.name,
      read: 0,
      imported: 0,
      duplicates: 0,
      excluded: 0,
      needsReview: 0,
    };
    units.push(unit);

    // 헤더 확인 — 다르면 열 매핑이 모호하므로 시트 전체를 분리
    let headerOk = true;
    for (const b of cfg.blocks) {
      const got = [b.no, b.english, b.pos, b.meaning].map((c) => cleanDisplay(sheet.cell(cfg.headerRow, c)));
      if (got.join('|') !== cfg.expectedHeader.join('|')) {
        headerOk = false;
        issues.push({ severity: 'error', type: 'header_mismatch', file: fileLabel, sheet: sheet.name, cell: `${b.no}${cfg.headerRow}:${b.meaning}${cfg.headerRow}`, message: `헤더가 예상(${cfg.expectedHeader.join(', ')})과 다름: ${got.join(', ')} → 시트 전체 보류` });
      }
    }
    if (!headerOk) return;

    const seenNo = new Map<number, string>();
    const seenPair = new Map<string, string>();
    for (let r = cfg.firstDataRow; r <= Math.max(sheet.rowCount, cfg.firstDataRow); r++) {
      for (const b of cfg.blocks) {
        const raw = {
          no: sheet.cell(r, b.no),
          english: sheet.cell(r, b.english),
          pos: sheet.cell(r, b.pos),
          meaning: sheet.cell(r, b.meaning),
          conf: b.confusables ? sheet.cell(r, b.confusables) : '',
        };
        if (![raw.no, raw.english, raw.pos, raw.meaning].some((v) => v.trim())) continue;
        unit.read++;
        const cell = `${b.no}${r}:${b.meaning}${r}`;
        for (const v of [raw.english, raw.meaning, raw.pos]) if (v && v !== v.trim()) trimmed++;
        const english = cleanDisplay(raw.english);
        const meaning = cleanDisplay(raw.meaning);
        const pos = cleanDisplay(raw.pos) || null;
        const no = Number(cleanDisplay(raw.no));
        const base = { file: fileLabel, sheet: sheet.name, cell, english, meaning };

        if (!english) {
          issues.push({ ...base, severity: 'error', type: 'missing_english', message: '영단어가 비어 있어 반영하지 않음' });
          unit.excluded++;
          continue;
        }
        if (!meaning) {
          issues.push({ ...base, severity: 'error', type: 'missing_meaning', message: '뜻이 비어 있어 반영하지 않음' });
          unit.excluded++;
          continue;
        }
        if (!Number.isInteger(no) || no <= 0) {
          issues.push({ ...base, severity: 'error', type: 'bad_number', message: `번호 '${raw.no}' 를 읽을 수 없어 반영하지 않음` });
          unit.excluded++;
          continue;
        }
        if (seenNo.has(no)) {
          issues.push({ ...base, severity: 'error', type: 'duplicate_number', message: `같은 시트에 번호 ${no} 가 또 있음 (${seenNo.get(no)}) → 이 행 보류` });
          unit.excluded++;
          continue;
        }
        seenNo.set(no, cell);
        const ek = englishKey(english);
        const senses = senseKeys(meaning);
        const pairKey = `${ek}|${senses.slice().sort().join(',')}`;
        if (seenPair.has(pairKey)) {
          issues.push({ ...base, severity: 'warning', type: 'duplicate_in_unit', message: `같은 Unit 에 같은 단어·뜻이 이미 있음 (${seenPair.get(pairKey)}) → 1개만 반영` });
          unit.duplicates++;
          continue;
        }
        seenPair.set(pairKey, cell);
        const confusables = raw.conf
          ? raw.conf.split(/[,;/]/).map(cleanDisplay).filter(Boolean)
          : [];
        const contentHash = crypto
          .createHash('sha1')
          .update(JSON.stringify([english, pos, meaning, confusables]))
          .digest('hex');
        let status: ParsedWord['status'] = 'active';
        let statusReason: string | null = null;
        if (senses.length === 0) {
          status = 'needs_review';
          statusReason = '뜻에서 비교 가능한 내용을 찾지 못함';
          unit.needsReview++;
        }
        words.push({
          unitCode: unit.code,
          unitLabel: unit.label,
          unitOrdinal: unit.ordinal,
          sheet: sheet.name,
          itemNo: no,
          english,
          englishKey: ek,
          pos,
          meaning,
          senses,
          kind: detectKind(english),
          confusables,
          conflicts: [],
          sourceCell: cell,
          contentHash,
          status,
          statusReason,
        });
        unit.imported++;
      }
    }
  });

  if (trimmed > 0) {
    issues.push({ severity: 'info', type: 'whitespace_trimmed', file: fileLabel, sheet: '*', cell: '*', message: `앞뒤 공백이 있던 칸 ${trimmed}개를 정리해 반영` });
  }

  // 동의·유사 그룹 → 단어별 충돌 키
  let synonymGroups = 0;
  if (cfg.synonymGroupsFile) {
    const gfile = path.resolve(root, cfg.synonymGroupsFile);
    const data = JSON.parse(fs.readFileSync(gfile, 'utf8')) as SynonymGroups;
    const known = new Set(words.map((w) => w.englishKey));
    const conflictMap = new Map<string, Set<string>>();
    for (const g of data.groups) {
      const keys = Array.from(new Set(g.items.map(englishKey)));
      for (const item of g.items) {
        if (!known.has(englishKey(item))) {
          issues.push({ severity: 'warning', type: 'synonym_group_unmatched', file: path.basename(gfile), sheet: g.name, cell: '-', english: item, message: `동의 그룹 '${g.name}'의 '${item}' 이(가) 단어장에 없음 → 무시` });
        }
      }
      for (const k of keys) {
        if (!conflictMap.has(k)) conflictMap.set(k, new Set());
        for (const o of keys) if (o !== k) conflictMap.get(k)!.add(o);
      }
      synonymGroups++;
    }
    for (const w of words) {
      w.conflicts = Array.from(conflictMap.get(w.englishKey) ?? []).sort();
      if (w.conflicts.length) {
        w.contentHash = crypto.createHash('sha1').update(JSON.stringify([w.english, w.pos, w.meaning, w.confusables, w.conflicts])).digest('hex');
      }
    }
  }

  // 책 전체 관점의 반복·동의어 정보 (출제 시 중복 방지·보기 제외에 쓰임)
  const byKey = new Map<string, ParsedWord[]>();
  for (const w of words) {
    if (!byKey.has(w.englishKey)) byKey.set(w.englishKey, []);
    byKey.get(w.englishKey)!.push(w);
  }
  let crossUnitRepeats = 0;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    const first = list[0];
    for (const w of list.slice(1)) {
      const same = w.senses.slice().sort().join(',') === first.senses.slice().sort().join(',');
      if (same) {
        crossUnitRepeats++;
        issues.push({ severity: 'info', type: 'duplicate_across_units', file: fileLabel, sheet: w.sheet, cell: w.sourceCell, english: w.english, meaning: w.meaning, message: `${first.unitLabel} ${first.sourceCell} 와 같은 단어·뜻. 두 Unit 에 모두 유지하고 한 회차에서는 1번만 출제` });
      } else {
        issues.push({ severity: 'info', type: 'same_english_different_meaning', file: fileLabel, sheet: w.sheet, cell: w.sourceCell, english: w.english, meaning: w.meaning, message: `${first.unitLabel} 의 '${first.english}'(${first.meaning}) 와 뜻이 다름. 영→한 문항에서 다른 뜻은 보기에서 제외` });
      }
    }
  }
  const bySense = new Map<string, Set<string>>();
  for (const w of words) for (const s of w.senses) {
    if (!bySense.has(s)) bySense.set(s, new Set());
    bySense.get(s)!.add(w.englishKey);
  }
  for (const [s, keys] of bySense) {
    if (keys.size < 2) continue;
    const list = words.filter((w) => w.senses.includes(s));
    const names = Array.from(new Set(list.map((w) => w.english)));
    if (names.length < 2) continue;
    issues.push({ severity: 'info', type: 'same_meaning_different_english', file: fileLabel, sheet: list[0].sheet, cell: list.map((w) => `${w.unitLabel} ${w.sourceCell}`).join(', '), meaning: s, message: `뜻 '${s}' 이(가) 여러 영어(${names.join(' / ')})에 쓰임. 한→영 문항에서 서로 보기로 쓰지 않음` });
  }

  return { file, fileLabel, sheets: sheets.length, units, words, issues, crossUnitRepeats, synonymGroups };
}

/** 학생용 시험지와 교차 확인 (왼쪽 블록: 영어, 오른쪽 블록: 뜻) */
export async function crossCheck(cfg: WordbookConfig, words: ParsedWord[], root = process.cwd()) {
  if (!cfg.crossCheckFile) return { file: null, compared: 0, mismatches: 0, issues: [] as ImportIssue[], note: '교차 확인 파일 없음' };
  const file = path.resolve(root, cfg.crossCheckFile);
  if (!fs.existsSync(file)) return { file: path.basename(file), compared: 0, mismatches: 0, issues: [] as ImportIssue[], note: '교차 확인 파일을 찾지 못함' };
  const sheets = await loadWorkbook(file);
  const re = new RegExp(cfg.sheetPattern);
  const issues: ImportIssue[] = [];
  let compared = 0;
  const label = path.basename(file);
  const byUnitNo = new Map(words.map((w) => [`${w.sheet.trim()}#${w.itemNo}`, w]));
  for (const s of sheets) {
    if (!re.test(s.name)) continue;
    for (let r = cfg.firstDataRow; r <= Math.max(s.rowCount, cfg.firstDataRow); r++) {
      for (const b of cfg.blocks) {
        const no = Number(cleanDisplay(s.cell(r, b.no)));
        if (!Number.isInteger(no) || no <= 0) continue;
        const w = byUnitNo.get(`${s.name.trim()}#${no}`);
        const eng = cleanDisplay(s.cell(r, b.english));
        const mean = cleanDisplay(s.cell(r, b.meaning));
        const cell = `${b.no}${r}:${b.meaning}${r}`;
        if (!w) {
          if (eng || mean) issues.push({ severity: 'warning', type: 'crosscheck_missing', file: label, sheet: s.name, cell, english: eng, meaning: mean, message: '학생용에는 있으나 교사용에 같은 번호가 없음' });
          continue;
        }
        compared++;
        // 학생용은 한쪽이 비어 있는 시험지이므로, 값이 있는 쪽만 비교
        if (eng && eng !== w.english) issues.push({ severity: 'warning', type: 'crosscheck_mismatch', file: label, sheet: s.name, cell, english: eng, message: `학생용 영어 '${eng}' ≠ 교사용 '${w.english}' (교사용 기준으로 반영)` });
        if (mean && mean !== w.meaning) issues.push({ severity: 'warning', type: 'crosscheck_mismatch', file: label, sheet: s.name, cell, meaning: mean, message: `학생용 뜻 '${mean}' ≠ 교사용 '${w.meaning}' (교사용 기준으로 반영)` });
      }
    }
  }
  return { file: label, compared, mismatches: issues.filter((i) => i.type === 'crosscheck_mismatch').length, issues, note: '학생용은 빈칸 시험지라 값이 있는 쪽만 교사용과 비교' };
}

/** 출제 점검: 책 전체를 보기 후보 풀로 하여 방향별 출제 가능 여부 계산 */
export function checkTestability(words: Array<Pick<ParsedWord, 'english' | 'englishKey' | 'pos' | 'meaning' | 'senses' | 'kind' | 'confusables' | 'conflicts' | 'unitOrdinal' | 'unitLabel' | 'itemNo'> & { id?: number; status: string }>) {
  const recs: WordRec[] = words
    .map((w, i) => ({ ...w, id: w.id ?? i + 1, confusables: w.confusables ?? [] }))
    .filter((w) => w.status === 'active') as unknown as WordRec[];
  const builder = new OptionBuilder(recs);
  return recs.map((w) => ({ id: w.id, ...builder.check(w) }));
}

/** DB 반영 */
export async function importWordbook(db: Db, cfg: WordbookConfig, opts: { dryRun?: boolean; root?: string; now?: Date } = {}): Promise<ImportReport> {
  const root = opts.root ?? process.cwd();
  const parsed = await parseWordbook(cfg, root);
  const cc = await crossCheck(cfg, parsed.words, root);
  const sha = sha256File(parsed.file);
  const issues = [...parsed.issues, ...cc.issues];

  // 출제 점검 (메모리)
  const checks = checkTestability(parsed.words.map((w, i) => ({ ...w, id: i + 1 })));
  const checkById = new Map(checks.map((c) => [c.id, c]));
  let testable = 0;
  parsed.words.forEach((w, i) => {
    const c = checkById.get(i + 1);
    if (!c) return;
    if (c.en2ko && c.ko2en) {
      issues.push({ severity: 'warning', type: 'not_testable', file: parsed.fileLabel, sheet: w.sheet, cell: w.sourceCell, english: w.english, meaning: w.meaning, message: `출제 불가 — 영→한: ${c.en2ko} / 한→영: ${c.ko2en}` });
    } else testable++;
  });
  const activeCount = parsed.words.filter((w) => w.status === 'active').length;

  const report: ImportReport = {
    wordbook: cfg.code,
    title: cfg.title,
    file: parsed.fileLabel,
    sha256: sha,
    ranAt: (opts.now ?? new Date()).toISOString(),
    dryRun: !!opts.dryRun,
    totals: {
      sheets: parsed.sheets,
      unitsRecognized: parsed.units.length,
      read: parsed.units.reduce((a, u) => a + u.read, 0),
      imported: parsed.units.reduce((a, u) => a + u.imported, 0) - parsed.units.reduce((a, u) => a + u.needsReview, 0),
      duplicates: parsed.units.reduce((a, u) => a + u.duplicates, 0),
      excluded: parsed.units.reduce((a, u) => a + u.excluded, 0),
      needsReview: parsed.units.reduce((a, u) => a + u.needsReview, 0),
      crossUnitRepeats: parsed.crossUnitRepeats,
      testable,
      notTestable: activeCount - testable,
    },
    units: parsed.units,
    issues,
    crossCheck: { file: cc.file, compared: cc.compared, mismatches: cc.mismatches, note: cc.note },
    synonymGroups: parsed.synonymGroups,
  };
  if (opts.dryRun) return report;

  const counts = await db.tx(async (q) => {
    const wb = (
      await q.query<{ id: number }>(
        `INSERT INTO wordbooks (code, title, is_sample) VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, is_sample = EXCLUDED.is_sample
         RETURNING id`,
        [cfg.code, cfg.title, !!cfg.isSample],
      )
    ).rows[0];
    const unitIds = new Map<string, number>();
    // ordinal 재배치 시 UNIQUE(wordbook_id, ordinal) 충돌을 피하려고 먼저 음수로 옮김
    await q.query('UPDATE units SET ordinal = -ordinal WHERE wordbook_id = $1 AND ordinal > 0', [wb.id]);
    for (const u of parsed.units) {
      const r = await q.query<{ id: number }>(
        `INSERT INTO units (wordbook_id, code, label, ordinal, source_file, source_sheet) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (wordbook_id, code) DO UPDATE SET label = EXCLUDED.label, ordinal = EXCLUDED.ordinal,
           source_file = EXCLUDED.source_file, source_sheet = EXCLUDED.source_sheet
         RETURNING id`,
        [wb.id, u.code, u.label, u.ordinal, parsed.fileLabel, u.sheet],
      );
      unitIds.set(u.code, r.rows[0].id);
    }
    const existing = await q.query<{ id: number; unit_id: number; item_no: number; content_hash: string; status: string }>(
      'SELECT id, unit_id, item_no, content_hash, status FROM words WHERE wordbook_id = $1',
      [wb.id],
    );
    const exMap = new Map(existing.rows.map((r) => [`${r.unit_id}#${r.item_no}`, r]));
    const seen = new Set<string>();
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    for (let i = 0; i < parsed.words.length; i++) {
      const w = parsed.words[i];
      const unitId = unitIds.get(w.unitCode)!;
      const k = `${unitId}#${w.itemNo}`;
      seen.add(k);
      const c = checkById.get(i + 1);
      const params = [
        wb.id, unitId, w.itemNo, w.english, w.englishKey, w.pos, w.meaning, JSON.stringify(w.senses), w.kind,
        JSON.stringify(w.confusables), w.status, w.statusReason, c?.en2ko ?? (w.status === 'active' ? null : w.statusReason),
        c?.ko2en ?? (w.status === 'active' ? null : w.statusReason), parsed.fileLabel, w.sheet, w.sourceCell, w.contentHash,
        JSON.stringify(w.conflicts),
      ];
      const prev = exMap.get(k);
      if (!prev) inserted++;
      else if (prev.content_hash !== w.contentHash || prev.status !== w.status) updated++;
      else unchanged++;
      await q.query(
        `INSERT INTO words (wordbook_id, unit_id, item_no, english, english_norm, pos, meaning, senses, kind, confusables,
            status, status_reason, check_en2ko, check_ko2en, checked_at, source_file, source_sheet, source_cell, content_hash, conflicts, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14, now(), $15,$16,$17,$18, $19::jsonb, now())
         ON CONFLICT (unit_id, item_no) DO UPDATE SET
           english = EXCLUDED.english, english_norm = EXCLUDED.english_norm, pos = EXCLUDED.pos, meaning = EXCLUDED.meaning,
           senses = EXCLUDED.senses, kind = EXCLUDED.kind, confusables = EXCLUDED.confusables, conflicts = EXCLUDED.conflicts, status = EXCLUDED.status,
           status_reason = EXCLUDED.status_reason, check_en2ko = EXCLUDED.check_en2ko, check_ko2en = EXCLUDED.check_ko2en,
           checked_at = now(), source_file = EXCLUDED.source_file, source_sheet = EXCLUDED.source_sheet,
           source_cell = EXCLUDED.source_cell,
           updated_at = CASE WHEN words.content_hash = EXCLUDED.content_hash THEN words.updated_at ELSE now() END,
           content_hash = EXCLUDED.content_hash`,
        params,
      );
    }
    // 원본에서 사라진 행은 지우지 않고 retired 로 (예전 회차는 스냅샷으로 재현)
    let retired = 0;
    for (const r of existing.rows) {
      if (!seen.has(`${r.unit_id}#${r.item_no}`) && r.status !== 'retired') {
        await q.query(`UPDATE words SET status = 'retired', status_reason = '원본에서 사라짐', updated_at = now() WHERE id = $1`, [r.id]);
        retired++;
      }
    }
    await q.query(`INSERT INTO import_runs (wordbook_id, source_file, file_sha256, summary) VALUES ($1,$2,$3,$4::jsonb)`, [
      wb.id,
      parsed.fileLabel,
      sha,
      JSON.stringify({ totals: report.totals, units: report.units, crossCheck: report.crossCheck }),
    ]);
    return { inserted, updated, unchanged, retired };
  });
  Object.assign(report.totals, counts);
  return report;
}

export function loadConfig(codeOrPath: string, root = process.cwd()): WordbookConfig {
  const p = codeOrPath.endsWith('.json') ? path.resolve(root, codeOrPath) : path.join(root, 'config', 'wordbooks', `${codeOrPath}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 사람이 읽는 요약 (Markdown) */
export function reportMarkdown(r: ImportReport): string {
  const t = r.totals;
  const lines = [
    `# 임포트 결과 — ${r.title} (${r.wordbook})`,
    '',
    `- 파일: \`${r.file}\` (sha256 ${r.sha256.slice(0, 16)}…)`,
    `- 실행: ${r.ranAt}${r.dryRun ? ' (dry-run, DB 미반영)' : ''}`,
    `- 시트 ${t.sheets}개 중 Unit 인식 ${t.unitsRecognized}개`,
    `- 읽음 ${t.read} · 정상 반영 ${t.imported} · 같은 Unit 중복 ${t.duplicates} · 제외 ${t.excluded} · 확인 필요 ${t.needsReview}`,
    `- 다른 Unit 반복(같은 단어·뜻) ${t.crossUnitRepeats} · 출제 가능 ${t.testable} · 출제 불가 ${t.notTestable}`,
    t.inserted !== undefined ? `- DB: 신규 ${t.inserted} · 갱신 ${t.updated} · 변경 없음 ${t.unchanged} · 원본에서 사라짐 ${t.retired}` : '',
    `- 교차 확인(${r.crossCheck.file ?? '없음'}): 비교 ${r.crossCheck.compared} · 불일치 ${r.crossCheck.mismatches} — ${r.crossCheck.note}`,
    `- 동의·유사 그룹 ${r.synonymGroups}개 적용 (같은 그룹 표현은 한 문항 보기로 함께 나오지 않음)`,
    '',
    '## Unit별',
    '',
    '| # | Unit | 시트 | 읽음 | 반영 | 중복 | 제외 | 확인 필요 |',
    '|---|---|---|---|---|---|---|---|',
    ...r.units.map((u) => `| ${u.ordinal} | ${u.label} (${u.code}) | ${u.sheet} | ${u.read} | ${u.imported - u.needsReview} | ${u.duplicates} | ${u.excluded} | ${u.needsReview} |`),
    '',
    '## 문제 행 (error/warning)',
    '',
  ];
  const serious = r.issues.filter((i) => i.severity !== 'info');
  if (!serious.length) lines.push('- 없음');
  for (const i of serious) lines.push(`- [${i.severity}] ${i.type} · ${i.file} › ${i.sheet} › ${i.cell} — ${i.message}${i.english ? ` (영어: ${i.english})` : ''}`);
  lines.push('', '## 참고 (info)', '');
  const byType = new Map<string, number>();
  for (const i of r.issues.filter((x) => x.severity === 'info')) byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
  for (const [k, v] of byType) lines.push(`- ${k}: ${v}건 (상세는 JSON 보고서)`);
  return lines.filter((l) => l !== null).join('\n');
}
