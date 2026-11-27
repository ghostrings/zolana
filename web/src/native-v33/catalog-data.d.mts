export function nativeMatches(m:{name:string;symbol:string;baseMint:string;address:string},query:string,pair:string):boolean;
export function catalogWindow(nativeCount:number,legacyCount:number,page:number,size:number):{total:number;pages:number;page:number;size:number;nativeStart:number;nativeEnd:number;legacyStart:number;legacyTake:number};
export function recentTradeStats(history:unknown):{points:{price:number;slot:number;time:number|null}[];volume:string;count:number;createdAt:number;incomplete:boolean};
