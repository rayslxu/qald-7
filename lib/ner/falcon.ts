import * as Tp from 'thingpedia';
import { Relation, Entity, Linker } from './base';
import { ENTITY_PREFIX } from '../utils/wikidata';
import WikidataUtils from '../utils/wikidata';

interface FalconOptions {
    cache : string,
    bootleg : string
}

export class Falcon extends Linker {
    private _wikidata : WikidataUtils;
    private _url : string;

    constructor(options : FalconOptions) {
        super();
        this._wikidata = new WikidataUtils(options.cache, options.bootleg);
        this._url = 'https://labs.tib.eu/falcon/falcon2/api?mode=long';
    }
    
    async run(input : string) {
        const entities : Entity[] = [];
        const relations : Relation[] = [];
        const raw = await Tp.Helpers.Http.post(this._url, `{"text":"${input}"}`, {
            dataContentType: 'application/json'
        });
        console.log(raw);
        const parsed = JSON.parse(raw);
        for (const entity of parsed.entities_wikidata) {
            const id = entity.URI.slice(ENTITY_PREFIX.length);
            entities.push({
                id,
                label: entity["surface form"],
                domain: await this._wikidata.getDomain(id),
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
        return { entities, relations };
    }

}