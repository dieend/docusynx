import type { PluginOptions } from './types.js';
interface DocusaurusContext {
    siteDir: string;
    siteConfig: {
        title?: string;
        url?: string;
        baseUrl?: string;
    };
}
interface AllContentLoadedArgs {
    allContent: unknown;
}
interface PostBuildArgs {
    outDir: string;
    routesPaths?: string[];
    siteConfig: DocusaurusContext['siteConfig'];
}
export interface DocusaurusPluginInstance {
    name: string;
    allContentLoaded(args: AllContentLoadedArgs): void;
    postBuild(args: PostBuildArgs): Promise<void>;
}
export default function docusynxPlugin(context: DocusaurusContext, options?: PluginOptions): DocusaurusPluginInstance;
export {};
