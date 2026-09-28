// Custom transformer: runs after oxc on plain JS.
export default (code) => code.replaceAll("__GREETING__", JSON.stringify("hi"));
