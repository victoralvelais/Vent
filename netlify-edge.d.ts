// Type declarations for the Netlify Edge Functions runtime globals.
// The `Netlify` global is injected by the Netlify Edge runtime at execution time;
// these declarations just teach TypeScript about it.

declare global {
  const Netlify: {
    env: {
      get(name: string): string | undefined;
      has(name: string): boolean;
      toObject(): Record<string, string>;
      set(name: string, value: string): void;
      delete(name: string): void;
    };
  };
}

export {};
