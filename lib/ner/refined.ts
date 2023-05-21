import fs from 'fs';
import path from 'path';
import * as child_process from 'child_process';
import { Example, Linker, LinkerResult } from './base';
import WikidataUtils from '../utils/wikidata';

export class ReFinEDLinker extends Linker {
    private _wikidata : WikidataUtils;
    private _path : string;
    private _model : string;

    constructor(wikidata : WikidataUtils, path : string, model ?: string) {
        super();
        this._wikidata = wikidata;
        this._path = path;
        this._model = model ?? 'questions_model';
    }
    
    async run(id : string, utterance : string, thingtalk : string) : Promise<LinkerResult> {
        throw Error('Use runAll for ReFinEDLinker');
    }

    async saferunAll(examples : Example[]) {
        const entitiesByExample : Record<string, any> = {};
        for (const f of fs.readdirSync(path.dirname(this._path))) {
            if (!f.startsWith(path.basename(this._path) + '-split'))
                continue;
            try {
                const p = path.join(path.dirname(this._path), f);
                const process = child_process.spawn('python', [`${__dirname}/../../../python/run_refined.py`, p, '--model', this._model], { stdio: ['pipe', 'pipe', 'inherit'] });
                const stdout : string = await new Promise((resolve, reject) => {
                    process.on('error', reject);
                    process.stdout.setEncoding('utf8');
                    let buffer = '';
                    process.stdout.on('data', (data) => buffer += data);
                    process.stdout.on('end', () => resolve(buffer));
                });
                Object.assign(entitiesByExample, JSON.parse(stdout));
            } catch(e) {
                console.log(e);
            }
        }

        for (const example of examples) {
            if (example.entities === undefined)
                example.entities = [];
            if (example.relation === undefined)
                example.relation = [];
            if (example.id in entitiesByExample) {
                for (const entity of entitiesByExample[example.id]) {
                    const domainId = await this._wikidata.getDomain(entity);
                    example.entities.push({
                        id : entity,
                        label: (await this._wikidata.getLabel(entity))!,
                        domain: domainId ? (domainId in this._wikidata.subdomains ? await this._wikidata.getLabel(domainId) : domainId) : null,
                        type: 'entity',
                    });
                }
            }
        }
    }
}