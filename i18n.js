// 翻译封装：把 host.t 包装成支持 {name} 占位符插值的函数。
// 每次都读取宿主当前语言，切换语言无需重载插件。
export function t(message, values = {}) {
  const translated = host.t(message);
  return translated.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
  );
}
