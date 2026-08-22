import { describe, it, expect } from 'vitest';
import { parseCSV } from './questions';

describe('parseCSV', () => {
  it('基础两列解析并跳过表头', () => {
    const rows = parseCSV('question,answer,type,options\n1+1=?,2\n2+2=?,4');
    expect(rows).toEqual([
      { question: '1+1=?', answer: '2', type: undefined, options: undefined },
      { question: '2+2=?', answer: '4', type: undefined, options: undefined },
    ]);
  });

  it('支持引号内逗号', () => {
    const rows = parseCSV('question,answer\n"下列哪个,是正确的","A, B"');
    expect(rows[0].question).toBe('下列哪个,是正确的');
    expect(rows[0].answer).toBe('A, B');
  });

  it('支持双引号转义（"" → "）', () => {
    const rows = parseCSV('question,answer\n"他说""你好""","ok"');
    expect(rows[0].question).toBe('他说"你好"');
  });

  it('支持引号内换行（题目多行不再错位）', () => {
    const csv = 'question,answer\n"第一行\n第二行","答案"';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].question).toBe('第一行\n第二行');
    expect(rows[0].answer).toBe('答案');
  });

  it('兼容 \r\n 与 \r 换行及 BOM', () => {
    const rows = parseCSV('\uFEFFquestion,answer\r\n1+1=?,2\r3+3=?,6');
    expect(rows).toHaveLength(2);
    expect(rows[1].answer).toBe('6');
  });

  it('过滤空行与字段不足的行', () => {
    const rows = parseCSV('question,answer\n\n1+1=?,2\n只有一列\n\n,,');
    expect(rows).toHaveLength(1);
  });

  it('末行无换行符也能解析', () => {
    const rows = parseCSV('question,answer\n1+1=?,2');
    expect(rows).toHaveLength(1);
  });

  it('只有表头时返回空数组', () => {
    expect(parseCSV('question,answer')).toEqual([]);
    expect(parseCSV('')).toEqual([]);
  });

  it('与导出格式可往返（引号转义互逆）', () => {
    const escape = (s: string) => `"${(s || '').replace(/"/g, '""')}"`;
    const csv = 'question,answer,type,options\n' +
      [escape('含"引号"与,逗号'), escape('答案'), escape('single'), escape('')].join(',') + '\n';
    const rows = parseCSV(csv);
    expect(rows[0].question).toBe('含"引号"与,逗号');
    expect(rows[0].answer).toBe('答案');
    expect(rows[0].type).toBe('single');
    expect(rows[0].options).toBeUndefined();
  });
});
