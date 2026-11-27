import type {TokenSummary} from '../../../shared/src/api.js';
import type {MarketV33} from '../../../shared/src/ghost-markets/v33-release.js';
import type {MarketView} from '../paging.js';
export type NativeCard = TokenSummary & {native:{market:string;registered:boolean;assetId:string|null;recentVolume:string|null;recentCount:number|null;incomplete:boolean;capKnown:boolean}};
export type NativeCatalog = {markets:MarketV33[];slot:number;releaseSlot:number};
export function nativeCatalog():Promise<NativeCatalog|null>;
export function matchingNative(snapshot:NativeCatalog|null,view:MarketView):MarketV33[];
export function catalogTokens(markets:MarketV33[],snapshot:NativeCatalog):Promise<NativeCard[]>;
