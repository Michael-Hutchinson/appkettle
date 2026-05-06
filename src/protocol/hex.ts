// Hex helpers used throughout the Across protocol layer.
// Most are exported for sibling modules; only the public ones are re-exported via index.ts.

export const u8hex = (n: number): string => n.toString(16).padStart(2, "0").toUpperCase();
export const u16hex4 = (n: number): string => n.toString(16).padStart(4, "0").toUpperCase();

export const strToHex = (s: string): string =>
  Buffer.from(s, "utf8").toString("hex").toUpperCase();

export const hexToStr = (h: string): string => Buffer.from(h, "hex").toString("utf8");

export const lenAsHexByte = (hexStr: string): string => u8hex(hexStr.length / 2);
export const lenAsHex2Bytes = (hexStr: string): string => u16hex4(hexStr.length / 2 + 1);

export const sign = (hexStr: string): string => {
  let total = 0;
  for (let i = 0; i < hexStr.length; i += 2) total += parseInt(hexStr.slice(i, i + 2), 16);
  return u8hex((total ^ 0xff) & 0xff);
};

export const stuff = (hexStr: string): string => {
  let out = "";
  for (let i = 0; i < hexStr.length; i += 2) {
    const b = hexStr.slice(i, i + 2).toUpperCase();
    out += b === "AA" ? "AA55" : b;
  }
  return out;
};

export const unstuff = (hexStr: string): string => {
  let out = "";
  let head = false;
  for (let i = 0; i < hexStr.length; i += 2) {
    const b = hexStr.slice(i, i + 2).toUpperCase();
    if (b === "AA") {
      out += "AA";
      head = true;
    } else {
      if (!(head && b === "55")) out += b;
      head = false;
    }
  }
  return out;
};
