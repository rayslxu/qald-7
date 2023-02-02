import * as argparse from 'argparse';
import WikidataUtils from '../utils/wikidata';
import { cleanName } from '../utils/misc';

class NERPromptGenerator {
    private _wikidata : WikidataUtils;

    constructor(wikidata : WikidataUtils) {
        this._wikidata = wikidata;
    }

    private async _retrieveProperties(entity : string) {
        const properties = await this._wikidata.getConnectedProperty(entity);
        const ttProperties = [];
        for (const property of properties) {
            const label = await this._wikidata.getLabel(property);
            ttProperties.push(cleanName(label!));
        }
        return ttProperties;
    }

    async prompt(utterance : string, entities : string[]) {
        const properties = [];
        for (const entity of entities) 
            properties.push(...(await this._retrieveProperties(entity)));
        let prompt = '';
        prompt += `Utterance: ${utterance} ?\n`;
        prompt += `Properties: ${properties.join(', ')}\n`;
        prompt += `Rephrase:`;
        return prompt;
    }
}

async function main() {
    const parser = new argparse.ArgumentParser({
        add_help : true,
        description : "Generate prompt for GPT-3 rephrase task"
    });
    parser.add_argument('-i', '--input', {
        required: true,
        help: "The input utterance"
    });
    parser.add_argument('--entities', {
        nargs: '+',
        required: true,
        help: `The QIDs of entities in the utterance`
    });
    parser.add_argument('--wikidata-cache', {
        required: false,
        default: 'wikidata_cache.sqlite'
    });
    parser.add_argument('--bootleg', {
        required: false,
        default: 'bootleg.sqlite'
    });

    const args = parser.parse_args();
    const wikidata = new WikidataUtils(args.wikidata_cache, args.bootleg);

    const prompter = new NERPromptGenerator(wikidata);
    const prompt = await prompter.prompt(args.input, args.entities);
    console.log(prompt);
}

if (require.main === module)
    main();