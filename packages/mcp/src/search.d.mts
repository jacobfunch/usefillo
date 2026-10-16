export declare function rankCapabilities<T>(
  items: readonly T[],
  query: string,
  document: (item: T) => {
    name: string;
    title: string;
    description: string;
    tags?: readonly string[];
  },
  limit?: number,
): T[];
