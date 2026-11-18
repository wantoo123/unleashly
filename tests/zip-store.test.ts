import { expect, test } from "bun:test";

import { createZip } from "../src/main/services/zip-store";

function readEntries(zip: Buffer) {
    const endOffset = zip.length - 22;
    expect(zip.readUInt32LE(endOffset)).toBe(0x06054b50);
    const count = zip.readUInt16LE(endOffset + 10);
    const centralOffset = zip.readUInt32LE(endOffset + 16);
    const entries: Array<{ name: string; data: Buffer }> = [];
    let cursor = centralOffset;
    for (let index = 0; index < count; index += 1) {
        expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
        const nameLength = zip.readUInt16LE(cursor + 28);
        const extraLength = zip.readUInt16LE(cursor + 30);
        const commentLength = zip.readUInt16LE(cursor + 32);
        const localOffset = zip.readUInt32LE(cursor + 42);
        const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
        expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50);
        const localNameLength = zip.readUInt16LE(localOffset + 26);
        const localExtraLength = zip.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const dataLength = zip.readUInt32LE(localOffset + 22);
        entries.push({ name, data: zip.subarray(dataStart, dataStart + dataLength) });
        cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

test("creates a valid stored zip with UTF-8 names", () => {
    const zip = createZip({
        "diagnostics.json": JSON.stringify({ ok: true }),
        "logs/最近.log": "hello\nworld\n",
    });
    const entries = readEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual(["diagnostics.json", "logs/最近.log"]);
    expect(entries[0].data.toString("utf8")).toBe('{"ok":true}');
    expect(entries[1].data.toString("utf8")).toBe("hello\nworld\n");
});

test("creates a valid empty zip", () => {
    const zip = createZip({});
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt16LE(zip.length - 12)).toBe(0);
});
