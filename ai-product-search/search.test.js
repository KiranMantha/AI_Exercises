import { test } from "node:test";
import assert from "node:assert/strict";
import { rank, openDb, SCHEMA } from "./search.js";

test("rank filters, and relaxes filters that match nothing", () => {
  const db = openDb(":memory:", false);
  db.exec(SCHEMA);
  const ins = db.prepare("insert into products(id,gender,type,name,colour,usage,season,image,embedding) values (?,?,?,?,?,?,?,?,?)");
  [[1n, "Men", [1, 0]], [2n, "Women", [1, 1]]].forEach(([id, g, [a, b]]) => {
    const v = new Float32Array(384); v[0] = a; v[1] = b;
    ins.run(id, g, "Heels", `n${id}`, "c", "u", "s", "i", Buffer.from(v.buffer));
  });
  const q = new Float32Array(384); q[0] = 1;
  assert.deepEqual(rank(db, q, { gender: "Women", types: [] }).map((p) => p.id), [2]);
  assert.equal(rank(db, q, { gender: "Boys", types: [] }).length, 2);
});
