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
        const process = child_process.spawn('python', [`${__dirname}/../../../python/run_refined.py`, this._path, '--model', this._model], { stdio: ['pipe', 'pipe', 'inherit'] });
        const stdout : string = await new Promise((resolve, reject) => {
            process.on('error', reject);
            process.stdout.setEncoding('utf8');
            let buffer = '';
            process.stdout.on('data', (data) => buffer += data);
            process.stdout.on('end', () => resolve(buffer));
        });
        const entitiesByExample = JSON.parse(stdout);

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