import { StringMap } from '../types/general';

const DECIMAL_RESOLUTION_REGEX = /^(\d+)x(\d+)$/; // eslint-disable-line no-useless-escape
const ATTR_LIST_REGEX = /\s*(.+?)\s*=((?:\".*?\")|.*?)(?:,|$)/g; // eslint-disable-line no-useless-escape

// adapted from https://github.com/kanongil/node-m3u8parse/blob/master/attrlist.js
class AttrList {
  public AUTOSELECT?: string;
  public BYTERANGE?: string;
  public CODECS?: string;
  public DEFAULT?: string;
  public FORCED?: string;
  public LANGUAGE?: string;
  public NAME!: string;
  public TYPE!: string;
  public URI!: string;

  constructor (attrs: string | StringMap) {
    if (typeof attrs === 'string') {
      attrs = AttrList.parseAttrList(attrs);
    }

    for (const attr in attrs) {
      if (attrs.hasOwnProperty(attr)) {
        this[attr] = attrs[attr];
      }
    }
  }

  decimalInteger (attrName: string): number {
    const intValue = parseInt(this[attrName], 10);
    if (intValue > Number.MAX_SAFE_INTEGER) {
      return Infinity;
    }

    return intValue;
  }

  hexadecimalInteger (attrName: string) {
    if (this[attrName]) {
      let stringValue = (this[attrName] || '0x').slice(2);
      stringValue = ((stringValue.length & 1) ? '0' : '') + stringValue;

      const value = new Uint8Array(stringValue.length / 2);
      for (let i = 0; i < stringValue.length / 2; i++) {
        value[i] = parseInt(stringValue.slice(i * 2, i * 2 + 2), 16);
      }

      return value;
    } else {
      return null;
    }
  }

  hexadecimalIntegerAsNumber (attrName: string): number {
    const intValue = parseInt(this[attrName], 16);
    if (intValue > Number.MAX_SAFE_INTEGER) {
      return Infinity;
    }

    return intValue;
  }

  decimalFloatingPoint (attrName: string): number {
    return parseFloat(this[attrName]);
  }

  enumeratedString (attrName: string): string {
    return this[attrName];
  }

  decimalResolution (attrName: string): {
    width: number,
    height: number
  } | undefined {
    const res = DECIMAL_RESOLUTION_REGEX.exec(this[attrName]);
    if (res === null) {
      return undefined;
    }

    return {
      width: parseInt(res[1], 10),
      height: parseInt(res[2], 10)
    };
  }

  static parseAttrList (input: string): StringMap {
    let match;
    const attrs = {};
    const quote = '"';
    ATTR_LIST_REGEX.lastIndex = 0;
    while ((match = ATTR_LIST_REGEX.exec(input)) !== null) {
      let value = match[2];

      if (value.indexOf(quote) === 0 &&
          value.lastIndexOf(quote) === (value.length - 1)) {
        value = value.slice(1, -1);
      }

      attrs[match[1]] = value;
    }
    return attrs;
  }
}

export default AttrList;
