import * as Tp from 'thingpedia';
import { wikibaseSdk } from 'wikibase-sdk'; 
import wikibase from 'wikibase-sdk';

const URL = 'https://query.wikidata.org/sparql';
const ENTITY_PREFIX = 'http://www.wikidata.org/entity/';

export default class WikidataUtils {
    private _wdk : wikibaseSdk;
    private _cache : Record<string, any>;

    constructor() {
        this._wdk = wikibase({ instance: 'https://www.wikidata.org' });
        this._cache = {};
    }

    private async _query(sparql : string) {
        console.log(sparql);
        const result = await this._request(`${URL}?query=${encodeURIComponent(sparql)}`);
        return result.results.bindings;
    }

    private async _request(url : string) {
        if (url in this._cache) 
            return this._cache[url];
        try {
            const result = await Tp.Helpers.Http.get(url, { accept: 'application/json' });
            const parsed = JSON.parse(result);
            this._cache[url] = parsed;
            return parsed;
        } catch(e) {
            console.log(e);
            return null;
        }
    }

    async getPropertyValue(entityId : string, propertyId : string) {
        const sparql = `SELECT ?v WHERE { wd:${entityId} wdt:${propertyId} ?v. } `;
        const res = await this._query(sparql);
        return res.map((r : any) => r.v.value.slice(ENTITY_PREFIX.length));
    }

    async getLabel(id : string) {
        const result = await this._request(this._wdk.getEntities({ 
            ids: [id],
            languages: ['en']
        }));
        if (result)
            return (Object.values(result.entities)[0] as any).labels.en.value;
        return id;
    }
}