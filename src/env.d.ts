/**
 * vinxi 在本环境发布包未携带 dist 类型（node_modules/vinxi/dist 缺失），
 * 这里补一个最小环境声明，保证 tsconfig 的 types 解析与 vinxi/client 模块导入可用。
 */
declare module 'vinxi/client';
