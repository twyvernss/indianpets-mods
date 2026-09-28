import { describe, expect, it } from 'vitest';
import { fnv1a32 } from '../lib/hash.js';
import { collectLinks, extractUrls, normaliseUrl } from '../lib/urls.js';

describe('extractUrls', () => {
  it('finds bare and Markdown links in a post body', () => {
    const text =
      'Please help! https://ketto.org/fundraiser/save-bruno and [mirror](https://milaap.org/fundraisers/bruno).';
    expect(extractUrls(text)).toEqual([
      'https://ketto.org/fundraiser/save-bruno',
      'https://milaap.org/fundraisers/bruno',
    ]);
  });

  it('strips sentence punctuation that is not part of the URL', () => {
    expect(extractUrls('see https://ketto.org/fundraiser/abc.')).toEqual([
      'https://ketto.org/fundraiser/abc',
    ]);
    expect(extractUrls('(https://ketto.org/fundraiser/abc)')).toEqual([
      'https://ketto.org/fundraiser/abc',
    ]);
  });

  it('keeps balanced parentheses inside a path', () => {
    expect(extractUrls('https://example.com/a_(b)_c')).toEqual(['https://example.com/a_(b)_c']);
  });

  it('accepts scheme-less www links, which Reddit auto-links', () => {
    expect(extractUrls('www.ketto.org/fundraiser/abc')).toEqual(['www.ketto.org/fundraiser/abc']);
  });

  it('returns nothing for text without links', () => {
    expect(extractUrls('my dog needs surgery')).toEqual([]);
    expect(extractUrls('')).toEqual([]);
  });
});

describe('normaliseUrl - campaign identity', () => {
  it('reduces a Ketto campaign to platform + slug', () => {
    const result = normaliseUrl('https://www.ketto.org/fundraiser/save-bruno?utm_source=whatsapp');
    expect(result?.key).toBe('ketto:save-bruno');
    expect(result?.platform).toBe('ketto');
  });

  it('matches the same campaign shared in different shapes', () => {
    const a = normaliseUrl('https://ketto.org/fundraiser/save-bruno');
    const b = normaliseUrl('http://www.ketto.org/fundraiser/save-bruno/?utm_campaign=x&ref=abc');
    const c = normaliseUrl('https://KETTO.ORG/fundraiser/Save-Bruno#donate');
    expect(a?.key).toBe(b?.key);
    expect(b?.key).toBe(c?.key);
  });

  it('handles Milaap, GoFundMe, ImpactGuru, Donatekart and Give', () => {
    expect(normaliseUrl('https://milaap.org/fundraisers/bruno-care')?.key).toBe('milaap:bruno-care');
    expect(normaliseUrl('https://www.gofundme.com/f/help-bruno')?.key).toBe('gofundme:help-bruno');
    expect(normaliseUrl('https://impactguru.com/fundraiser/bruno')?.key).toBe('impactguru:bruno');
    expect(normaliseUrl('https://donatekart.com/fundraiser/bruno')?.key).toBe('donatekart:bruno');
    expect(normaliseUrl('https://give.do/fundraisers/bruno')?.key).toBe('give:bruno');
  });

  it('does not confuse two different campaigns on one platform', () => {
    expect(normaliseUrl('https://ketto.org/fundraiser/bruno')?.key).not.toBe(
      normaliseUrl('https://ketto.org/fundraiser/whiskers')?.key,
    );
  });
});

describe('normaliseUrl - generic links', () => {
  it('drops tracking parameters but keeps identifying ones', () => {
    const a = normaliseUrl('https://example.org/campaign?id=77&utm_source=x&fbclid=y');
    const b = normaliseUrl('https://example.org/campaign?id=77');
    expect(a?.key).toBe(b?.key);
    expect(a?.key).toContain('id=77');
  });

  it('is insensitive to query parameter order', () => {
    expect(normaliseUrl('https://example.org/c?b=2&a=1')?.key).toBe(
      normaliseUrl('https://example.org/c?a=1&b=2')?.key,
    );
  });

  it('flags shorteners so a moderator knows the destination was not checked', () => {
    const result = normaliseUrl('https://bit.ly/3abcdef');
    expect(result?.shortened).toBe(true);
    expect(result?.key).toContain('bit.ly');
  });

  it('ignores hosts that would only ever produce false positives', () => {
    expect(normaliseUrl('https://www.reddit.com/r/IndianPets/wiki/rules')).toBeNull();
    expect(normaliseUrl('https://i.redd.it/abc.jpg')).toBeNull();
    expect(normaliseUrl('https://imgur.com/a/xyz')).toBeNull();
    expect(normaliseUrl('https://youtu.be/abc')).toBeNull();
  });

  it('rejects unparseable and non-http input', () => {
    expect(normaliseUrl('not a url')).toBeNull();
    expect(normaliseUrl('javascript:alert(1)')).toBeNull();
    expect(normaliseUrl('')).toBeNull();
  });

  it('bounds the key length for absurdly long URLs', () => {
    const long = normaliseUrl(`https://example.org/${'a'.repeat(4000)}`);
    expect(long).not.toBeNull();
    expect(long?.key.length).toBeLessThan(200);
    expect(long?.key.startsWith('h:')).toBe(true);
  });
});

describe('collectLinks', () => {
  it('deduplicates the same campaign appearing several times in one post', () => {
    const links = collectLinks({
      title: 'Help Bruno https://ketto.org/fundraiser/save-bruno',
      body: 'Mirror: https://www.ketto.org/fundraiser/save-bruno/?utm_source=x',
      url: 'https://ketto.org/fundraiser/save-bruno',
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.key).toBe('ketto:save-bruno');
  });

  it('bounds how much work one post can cause', () => {
    const body = Array.from(
      { length: 40 },
      (_, index) => `https://example.org/c${index}`,
    ).join(' ');
    expect(collectLinks({ body }, 10)).toHaveLength(10);
  });

  it('returns nothing for a post with no usable links', () => {
    expect(collectLinks({ title: 'my dog is sick', body: 'please help' })).toEqual([]);
  });
});

describe('fnv1a32', () => {
  it('is deterministic and fixed width', () => {
    expect(fnv1a32('hello')).toBe(fnv1a32('hello'));
    expect(fnv1a32('hello')).toHaveLength(8);
  });

  it('separates similar inputs', () => {
    expect(fnv1a32('hello')).not.toBe(fnv1a32('hellp'));
  });
});
