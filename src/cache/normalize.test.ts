import { describe, it, expect } from 'vitest';
import { normalizeQuestion, normalizeOptions, normalizeAndHash } from './normalize';

describe('normalizeQuestion', () => {
  it('等价写法归一化为同一结果（缓存命中前提）', () => {
    // 注：+ - = 等数学符号不剥离（保留区分度），仅空白/标点/大小写归一
    expect(normalizeQuestion('What is 2 + 2 ?')).toBe(normalizeQuestion('what is 2+2?'));
  });

  it('去除 HTML 标签与实体', () => {
    expect(normalizeQuestion('<p>题目<br/>内容</p>')).toBe(normalizeQuestion('题目 内容'));
    expect(normalizeQuestion('A&nbsp;B')).toBe(normalizeQuestion('AB'));
  });

  it('去除【题型】标记与分值标记（半角/全角）', () => {
    expect(normalizeQuestion('【单选题】下列哪个正确')).toBe(normalizeQuestion('下列哪个正确'));
    expect(normalizeQuestion('(5分) 题目')).toBe(normalizeQuestion('题目'));
    expect(normalizeQuestion('（5分）题目')).toBe(normalizeQuestion('题目'));
  });

  it('去除中英文标点与所有空白（含全角空格）', () => {
    expect(normalizeQuestion('氢　氧化钠，是。碱！')).toBe(normalizeQuestion('氢氧化钠是碱'));
    expect(normalizeQuestion("it's (ok) [x] {y}")).toBe(normalizeQuestion('itsokxy'));
  });

  it('大写转小写', () => {
    expect(normalizeQuestion('ABC')).toBe('abc');
  });

  it('只含标记/标点/空白时归一化为空串', () => {
    expect(normalizeQuestion('【单选题】（5分）')).toBe('');
    expect(normalizeQuestion('???')).toBe('');
    expect(normalizeQuestion('　 \n\t')).toBe('');
  });
});

describe('normalizeOptions', () => {
  it('剥离行首字母标签与空白（半角/全角分隔符、全角字母）', () => {
    expect(normalizeOptions('A. 苹果\nB、香蕉\nC）梨')).toBe(normalizeOptions('苹果\n香蕉\n梨'));
    expect(normalizeOptions('Ａ．甲\nＢ．乙')).toBe(normalizeOptions('A. 甲\nB. 乙'));
  });

  it('选项顺序无关（排序后 join）', () => {
    expect(normalizeOptions('A. 甲\nB. 乙\nC. 丙')).toBe(normalizeOptions('C. 丙\nB. 乙\nA. 甲'));
  });

  it('空行/纯标签行被过滤，空选项归一化为空串', () => {
    expect(normalizeOptions('')).toBe('');
    expect(normalizeOptions('\n \n A.\n')).toBe('');
  });

  it('去除 HTML 标签与实体（与题干归一化对齐）', () => {
    expect(normalizeOptions('<p>A. x</p>\n<p>B. y</p>')).toBe(normalizeOptions('A. x\nB. y'));
  });

  it('大小写归一', () => {
    expect(normalizeOptions('A. Yes\nB. No')).toBe(normalizeOptions('A. YES\nB. no'));
  });
});

describe('normalizeAndHash（缓存键含选项）', () => {
  const T = '下列哪项正确';

  it('同题干不同选项 → 哈希不同（不再共享缓存）', async () => {
    const a = await normalizeAndHash(T, 'A. 甲\nB. 乙');
    const b = await normalizeAndHash(T, 'A. 甲\nB. 丙');
    expect(a.hash).not.toBe(b.hash);
  });

  it('同题干同选项（顺序/标签风格/空白不同）→ 哈希一致', async () => {
    const a = await normalizeAndHash(T, 'A. 甲\nB. 乙');
    const b = await normalizeAndHash(T, 'B、乙\nA、甲');
    expect(a.hash).toBe(b.hash);
  });

  it('选项文本伪造 \\u0001 分隔符不会与真实多选项碰撞', async () => {
    // 单选项内容中嵌入 \u0001，不得伪装成两个选项
    const a = await normalizeAndHash(T, '甲\u0001乙');
    const b = await normalizeAndHash(T, 'A. 甲\nB. 乙');
    expect(a.hash).not.toBe(b.hash);
  });

  it('无选项/空选项 → 哈希与旧版题干哈希一致（存量缓存兼容）', async () => {
    const none = await normalizeAndHash(T);
    const empty = await normalizeAndHash(T, '');
    const blank = await normalizeAndHash(T, '\n \n');
    expect(none.hash).toBe(empty.hash);
    expect(empty.hash).toBe(blank.hash);
  });

  it('返回 optionsNorm（无选项为空串）', async () => {
    const r = await normalizeAndHash(T, 'B. 乙\nA. 甲');
    expect(r.optionsNorm).toBe(normalizeOptions('A. 甲\nB. 乙'));
    expect((await normalizeAndHash(T)).optionsNorm).toBe('');
  });

  it('选项条数不同不碰撞：{甲,乙} ≠ {乙甲}（join 分隔符不可被剥离）', async () => {
    // 两选项排序拼接后为“乙甲”，恰与单选项文本“乙甲”同形——分隔符必须在键中保留
    const a = await normalizeAndHash(T, 'A. 甲\nB. 乙');
    const b = await normalizeAndHash(T, 'A. 乙甲');
    expect(a.hash).not.toBe(b.hash);
    // 三选项的两种拆分/合并方式互不碰撞
    const c = await normalizeAndHash(T, 'A. 甲\nB. 乙\nC. 丙');
    const d = await normalizeAndHash(T, 'A. 丙乙甲');
    const e = await normalizeAndHash(T, 'A. 甲\nB. 乙丙');
    expect(c.hash).not.toBe(d.hash);
    expect(c.hash).not.toBe(e.hash);
    expect(d.hash).not.toBe(e.hash);
  });

  it('化学元素串选项不被误剥标签（C、H、O 整行保留，与 ZError 守卫一致）', () => {
    // 无标签的元素列表 vs 带标签的同一组选项 → 归一化一致
    expect(normalizeOptions('C、H、O\nN、P、K')).toBe(normalizeOptions('A. C、H、O\nB. N、P、K'));
    expect(normalizeOptions('H、O')).toBe(normalizeOptions('A. H、O'));
    // 元素串行首不是标签：不得与“真被剥了标签”的选项集碰撞
    expect(normalizeOptions('C、H、O')).not.toBe(normalizeOptions('A. H、O'));
    expect(normalizeOptions('C、H、O\nX、Y')).not.toBe(normalizeOptions('A. H、O\nB. X、Y'));
    // 普通信顿号标签仍正常剥离
    expect(normalizeOptions('B、香蕉')).toBe('香蕉');
    expect(normalizeOptions('A、选项甲')).toBe('选项甲');
  });

  it('题干中的 \\u0000 不会与“题干+选项”组合键碰撞', async () => {
    const a = await normalizeAndHash('甲\u0000乙');      // 无选项
    const b = await normalizeAndHash('甲', '乙');         // 题干 + 选项
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('normalizeAndHash', () => {
  it('返回 64 位十六进制 SHA-256，且等价题目哈希一致', async () => {
    const a = await normalizeAndHash('中国的首都是哪里？');
    const b = await normalizeAndHash('中国 的首都是哪里');
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.normalized).not.toBe('');
    expect(a.hash).toBe(b.hash);
  });

  it('空串题目哈希为 SHA-256("")（调用方需据此拒绝空归一化输入）', async () => {
    const { hash } = await normalizeAndHash('???');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
