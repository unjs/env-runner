// CommonJS `.ts` in a package without `"type"` (Node gives no format hint).
enum Kind {
  Lib = "lib",
}
module.exports = { value: Kind.Lib };
