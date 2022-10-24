import * as Tp from 'thingpedia';
import { Relation, Entity, Linker } from './base';
import { ENTITY_PREFIX } from '../utils/wikidata';
import WikidataUtils from '../utils/wikidata';
import Cache from '../utils/cache';

interface FalconOptions {
    ner_cache : string,
    wikidata_cache : string,
    bootleg : string
}

export class Falcon extends Linker {
    private _wikidata : WikidataUtils;
    private _url : string;
    private _cache : Cache;

    constructor(options : FalconOptions) {
        super();
        this._wikidata = new WikidataUtils(options.wikidata_cache, options.bootleg);
        this._url = 'https://labs.tib.eu/falcon/falcon2/api?mode=long';
        this._cache = new Cache(options.ner_cache);
    }
    
    async run(input : string) {
        const cache = await this._cache.get(input);
        if (cache)
            return JSON.parse(cache);
        const entities : Entity[] = [];
        const relations : Relation[] = [];
        const raw = await Tp.Helpers.Http.post(this._url, `{"text":"${input}"}`, {
            dataContentType: 'application/json'
        });
        const parsed = JSON.parse(raw);
        for (const entity of parsed.entities_wikidata) {
            const id = entity.URI.slice(ENTITY_PREFIX.length);
            const domainId = await this._wikidata.getDomain(id);
            entities.push({
                id,
                label: entity["surface form"],
                domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                type: 'entity'
            });
        }
        for (const relation of parsed.relations_wikidata) {
            relations.push({
                id: relation.URI.slice(ENTITY_PREFIX.length),
                label: relation["surface form"],
                type: 'relation'
            });
        }
        const result = { entities, relations };
        this._cache.set(input, JSON.stringify(result));
        return result;
    }

}