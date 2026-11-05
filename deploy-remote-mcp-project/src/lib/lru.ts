/**
 * 有界 Map：插入时把 key 移到队尾，超过上限时淘汰最早写入的条目。
 *
 * 三个服务端结果的缓存（行情、回测、引擎扫描）原先只增不减，且 key 里带有
 * 用户可控的 symbol：实测 60 次随机 symbol 请求即让进程 RSS 从 145MB 涨到
 * 316MB，且因为 Map 一直持有引用，GC 也无法回收。
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest as K);
  }
}
