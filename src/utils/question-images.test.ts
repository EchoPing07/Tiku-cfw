import { describe, it, expect } from 'vitest';
import { normalizeQuestion } from '../cache/normalize';
import {
  extractImageMatches,
  extractUrlInfo,
  splitTextImageParts,
  parseImagePatterns,
  DEFAULT_IMAGE_URL_PATTERN_SOURCES,
} from './question-images';

describe('extractImageMatches：<img> 标签', () => {
  it('三种引号形态与大小写均可提取，span 覆盖整个标签', () => {
    const m = extractImageMatches('如图 <img src="https://x.com/a.png"> 所示');
    expect(m).toHaveLength(1);
    expect(m[0].url).toBe('https://x.com/a.png');
    expect(m[0].isImage).toBe(true);
    expect(m[0].start).toBe(3);
    expect(m[0].end).toBe(3 + '<img src="https://x.com/a.png">'.length);

    expect(extractImageMatches("<img src='https://x.com/a.png'>")).toHaveLength(1);
    expect(extractImageMatches('<IMG SRC=https://x.com/a.png alt=y>')).toHaveLength(1);
  });

  it('src 属性值中的 HTML 实体被解码（&amp; 与裸 & 是同一张图）', () => {
    const m = extractImageMatches('<img src="https://x.com/a.png?x=1&amp;y=2">');
    expect(m[0].url).toBe('https://x.com/a.png?x=1&y=2');
  });

  it('带其他属性的标签、自闭合标签均可提取', () => {
    expect(extractImageMatches('<img alt="图" data-x="1" src="https://x.com/a.png" />')).toHaveLength(1);
  });

  it('裸域名 src 跳过（占位/坏图非题目区分性内容，与 ZError 过滤一致）', () => {
    expect(extractImageMatches('<img src="https://example.com">')).toHaveLength(0);
  });
});

describe('extractImageMatches：markdown 图片', () => {
  it('![alt](url) 提取，span 覆盖整段 markdown', () => {
    const m = extractImageMatches('如图![公式](https://x.com/f.png)所示');
    expect(m).toHaveLength(1);
    expect(m[0].url).toBe('https://x.com/f.png');
    expect(m[0].isImage).toBe(true);
    expect(m[0].start).toBe(2);
    expect(m[0].end).toBe(2 + '![公式](https://x.com/f.png)'.length);
  });

  it('尖括号 URL 与带 title 形态', () => {
    expect(extractImageMatches('![a](<https://x.com/f.png>)')).toHaveLength(1);
    expect(extractImageMatches('![a](https://x.com/f.png "标题")')).toHaveLength(1);
  });
});

describe('extractImageMatches：裸 URL 清洗规则', () => {
  it('尾随标点剥离（中英文句读）', () => {
    expect(extractImageMatches('见 https://x.com/a.png.')[0].url).toBe('https://x.com/a.png');
    expect(extractImageMatches('见 https://x.com/a.png，')[0].url).toBe('https://x.com/a.png');
    expect(extractImageMatches('见 https://x.com/a.png。下一句')[0].url).toBe('https://x.com/a.png');
  });

  it('括号守卫：成对括号保留（URL 参数的一部分），多余右括号剥离', () => {
    // 全角（不在 URL 字符类中）：匹配自然止于 png
    expect(extractImageMatches('（见 https://x.com/a.png）')[0].url).toBe('https://x.com/a.png');
    // 半角括号在字符类中：成对保留
    expect(extractImageMatches('https://x.com/f_(1).png')[0].url).toBe('https://x.com/f_(1).png');
    // 多余的右括号属于正文
    expect(extractImageMatches('https://x.com/a.png)')[0].url).toBe('https://x.com/a.png');
    // 尾随孤立左括号属于后续正文
    expect(extractImageMatches('https://x.com/a.png(见下图)')[0].url).toBe('https://x.com/a.png');
  });

  it('图片后缀截断：后缀后粘连的字符归还文本流（trailingText）', () => {
    const m = extractImageMatches('自由度为 https://x.com/a.png_3 个');
    expect(m[0].url).toBe('https://x.com/a.png');
    expect(m[0].trailingText).toBe('_3');
    // query 参数不是粘连内容，保留
    expect(extractImageMatches('https://x.com/a.png?w=100')[0].url).toBe('https://x.com/a.png?w=100');
  });

  it('超星 LaTeX 链接截断到 id：不同渲染参数归一为同一 URL（身份）；fetchUrl 保留原形态', () => {
    const m = extractImageMatches('https://mooc1.chaoxing.com/ananas/latex/p/12345.png');
    expect(m[0].url).toBe('https://mooc1.chaoxing.com/ananas/latex/p/12345');
    expect(m[0].fetchUrl).toBe('https://mooc1.chaoxing.com/ananas/latex/p/12345.png');

    const m2 = extractImageMatches('https://mooc1-1.chaoxing.com/ananas/latex/p/12345');
    expect(m2[0].url).toBe('https://mooc1-1.chaoxing.com/ananas/latex/p/12345');
    expect(m2[0].isImage).toBe(true); // 无后缀，靠 /ananas/ 默认模式识别为图题
  });

  it('裸域名 URL（协议后无路径）完全忽略：不提取、不参与身份', () => {
    expect(extractImageMatches('来源 https://www.zhihuishu.com 仅供参考')).toHaveLength(0);
  });

  it('大写协议头 HTTPS:// 同样匹配（i 标志），且扩展名大小写不敏感', () => {
    const m = extractImageMatches('见 HTTPS://x.com/A.PNG 所示');
    expect(m).toHaveLength(1);
    expect(m[0].url).toBe('HTTPS://x.com/A.PNG');
    expect(m[0].isImage).toBe(true);
  });

  it('无图片后缀且不命中模式的带路径 URL：Tier 2（参与身份、不路由）', () => {
    const m = extractImageMatches('详见 https://x.com/doc/page1 说明');
    expect(m).toHaveLength(1);
    expect(m[0].isImage).toBe(false);
  });

  it('多个 URL 均可提取（含负向前瞻语义：粘连捕获不丢第二个 URL）', () => {
    const m = extractImageMatches('图1 https://x.com/a.png 图2 https://x.com/b.png');
    expect(m.map((x) => x.url)).toEqual(['https://x.com/a.png', 'https://x.com/b.png']);
  });

  it('img 标签内的 URL 不会被裸 URL 规则重复提取', () => {
    expect(extractImageMatches('<img src="https://x.com/a.png">')).toHaveLength(1);
  });

  it('自定义 patterns 可将无后缀 URL 识别为图片性', () => {
    const m = extractImageMatches('见 https://s.com/imgview?fid=9 图', {
      patterns: [new RegExp('imgview', 'i')],
    });
    expect(m[0].isImage).toBe(true);
  });
});

describe('extractUrlInfo：占位替换文本', () => {
  it('所有 URL 替换为 __URL__，trailingText 归还文本流', () => {
    const r = extractUrlInfo('自由度为 https://x.com/a.png_3 个单位');
    expect(r.text).toBe('自由度为 __URL___3 个单位');
    expect(r.urls).toEqual(['https://x.com/a.png']);
    expect(r.imageUrls).toEqual(['https://x.com/a.png']);
  });

  it('img 标签整段替换为占位符（URL 不再随标签剥离而丢失）', () => {
    const r = extractUrlInfo('如图<img src="https://x.com/a.png">所示');
    expect(r.text).toBe('如图__URL__所示');
  });

  it('同图不同形态（img / 裸 URL / markdown）归一化后文本与 URL 集合一致（同键前提）', () => {
    // 占位替换保留周围空白，但归一化会删空白——比较须在 normalizeQuestion 之后
    const forms = [
      '如图<img src="https://x.com/a.png">所示',
      '如图 https://x.com/a.png 所示',
      '如图![x](https://x.com/a.png)所示',
    ];
    const infos = forms.map((f) => extractUrlInfo(f));
    for (const info of infos) {
      expect(normalizeQuestion(info.text)).toBe('如图__url__所示');
      expect(info.urls).toEqual(['https://x.com/a.png']);
    }
  });

  it('Tier 2 URL 同样替换占位并计入 urls（身份），但不进 imageUrls', () => {
    const r = extractUrlInfo('详见 https://x.com/doc/page1 说明');
    expect(r.text).toBe('详见 __URL__ 说明');
    expect(r.urls).toEqual(['https://x.com/doc/page1']);
    expect(r.imageUrls).toEqual([]);
  });

  it('无 URL 文本原样返回', () => {
    const r = extractUrlInfo('普通题目 1+1=?');
    expect(r.text).toBe('普通题目 1+1=?');
    expect(r.urls).toEqual([]);
  });
});

describe('splitTextImageParts：图文交错分段', () => {
  it('图片性 URL 变为 image 段且保持原文位置', () => {
    const parts = splitTextImageParts('前文 https://x.com/a.png 后文');
    expect(parts).toEqual([
      { type: 'text', text: '前文 ' },
      { type: 'image', url: 'https://x.com/a.png', fetchUrl: 'https://x.com/a.png' },
      { type: 'text', text: ' 后文' },
    ]);
  });

  it('trailingText 归还到图片后的文本段', () => {
    const parts = splitTextImageParts('自由度为 https://x.com/a.png_3 个');
    expect(parts[1]).toMatchObject({ type: 'image', url: 'https://x.com/a.png' });
    expect(parts[2]).toEqual({ type: 'text', text: '_3 个' });
  });

  it('多图保序交错', () => {
    const parts = splitTextImageParts('A <img src="https://x/1.png"> B https://x/2.png C');
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(parts[1].url).toBe('https://x/1.png');
    expect(parts[3].url).toBe('https://x/2.png');
  });

  it('Tier 2 URL 保留在文本段原文中（不进图片段）', () => {
    const parts = splitTextImageParts('见 https://x.com/doc/page1 说明');
    expect(parts).toEqual([{ type: 'text', text: '见 https://x.com/doc/page1 说明' }]);
  });

  it('无图片时返回单一文本段', () => {
    expect(splitTextImageParts('纯文本')).toEqual([{ type: 'text', text: '纯文本' }]);
  });
});

describe('parseImagePatterns：settings 热更模式解析', () => {
  it('空/非法输入回退默认 /ananas/', () => {
    const def = DEFAULT_IMAGE_URL_PATTERN_SOURCES.map((s) => new RegExp(s, 'i'));
    for (const raw of [null, undefined, '', '   ', 'not-json', '"str"', '123', '[]', '["("]']) {
      const got = parseImagePatterns(raw as string | null);
      expect(got.map((r) => r.source)).toEqual(def.map((r) => r.source));
    }
  });

  it('合法 JSON 数组生效，个别非法正则条目跳过', () => {
    const got = parseImagePatterns('["/ananas/", "imgview", "("]');
    // 注意 RegExp.source 会将 / 转义为 \/（规范行为），两侧同构构造比较
    expect(got.map((r) => r.source)).toEqual([new RegExp('/ananas/').source, 'imgview']);
  });
});
