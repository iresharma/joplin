import { Item, Uuid } from '../../db';
import { formParse } from '../../utils/requestUtils';
import { respondWithItemContent, SubPath } from '../../utils/routeUtils';
import Router from '../../utils/Router';
import { RouteType } from '../../utils/types';
import { AppContext } from '../../utils/types';
import * as fs from 'fs-extra';
import { ErrorMethodNotAllowed, ErrorNotFound } from '../../utils/errors';
import ItemModel, { ItemSaveOption } from '../../models/ItemModel';
import { requestDeltaPagination, requestPagination } from '../../models/utils/pagination';
import { AclAction } from '../../models/BaseModel';
import { safeRemove } from '../../utils/fileUtils';

const router = new Router(RouteType.Api);

// Note about access control:
//
// - All these calls are scoped to a user, which is derived from the session
// - All items are accessed by userId/itemName
// - In other words, it is not possible for a user to access another user's
//   items, thus the lack of checkIfAllowed() calls as that would not be
//   necessary, and would be slower.
// - For now, users who are shared a folder with have full access to all items
//   within that folder. Except that they cannot delete the root folder if they
//   are not the owner, so there's a check in this case.

async function itemFromPath(userId: Uuid, itemModel: ItemModel, path: SubPath, mustExists: boolean = true): Promise<Item> {
	const name = itemModel.pathToName(path.id);
	const item = await itemModel.loadByName(userId, name);
	if (mustExists && !item) throw new ErrorNotFound(`Not found: ${path.id}`);
	return item;
}

router.get('api/items/:id', async (path: SubPath, ctx: AppContext) => {
	const itemModel = ctx.models.item();
	const item = await itemFromPath(ctx.owner.id, itemModel, path);
	return itemModel.toApiOutput(item);
});

router.del('api/items/:id', async (path: SubPath, ctx: AppContext) => {
	try {
		if (path.id === 'root' || path.id === 'root:/:') {
			// We use this for testing only and for safety reasons it's probably
			// best to disable it on production.
			if (ctx.env !== 'dev') throw new ErrorMethodNotAllowed('Deleting the root is not allowed');
			await ctx.models.item().deleteAll(ctx.owner.id);
		} else {
			const item = await itemFromPath(ctx.owner.id, ctx.models.item(), path);
			await ctx.models.item().checkIfAllowed(ctx.owner, AclAction.Delete, item);
			await ctx.models.item().deleteForUser(ctx.owner.id, item);
		}
	} catch (error) {
		if (error instanceof ErrorNotFound) {
			// That's ok - a no-op
		} else {
			throw error;
		}
	}
});

router.get('api/items/:id/content', async (path: SubPath, ctx: AppContext) => {
	const itemModel = ctx.models.item();
	const item = await itemFromPath(ctx.owner.id, itemModel, path);
	const serializedContent = await itemModel.serializedContent(item.id);
	return respondWithItemContent(ctx.response, item, serializedContent);
});

router.put('api/items/:id/content', async (path: SubPath, ctx: AppContext) => {
	const itemModel = ctx.models.item();
	const name = itemModel.pathToName(path.id);
	const parsedBody = await formParse(ctx.req);
	const filePath = parsedBody?.files?.file ? parsedBody.files.file.path : null;

	let outputItem: Item = null;

	try {
		const buffer = filePath ? await fs.readFile(filePath) : Buffer.alloc(0);
		const saveOptions: ItemSaveOption = {};

		// This end point can optionally set the associated jop_share_id field. It
		// is only useful when uploading resource blob (under .resource folder)
		// since they can't have metadata. Note, Folder and Resource items all
		// include the "share_id" field property so it doesn't need to be set via
		// query parameter.
		if (ctx.query['share_id']) {
			saveOptions.shareId = ctx.query['share_id'];
			await itemModel.checkIfAllowed(ctx.owner, AclAction.Create, { jop_share_id: saveOptions.shareId });
		}

		const item = await itemModel.saveFromRawContent(ctx.owner, name, buffer, saveOptions);
		outputItem = itemModel.toApiOutput(item) as Item;
	} finally {
		if (filePath) await safeRemove(filePath);
	}

	return outputItem;
});

router.get('api/items/:id/delta', async (_path: SubPath, ctx: AppContext) => {
	const changeModel = ctx.models.change();
	return changeModel.delta(ctx.owner.id, requestDeltaPagination(ctx.query));
});

router.get('api/items/:id/children', async (path: SubPath, ctx: AppContext) => {
	const itemModel = ctx.models.item();
	const parentName = itemModel.pathToName(path.id);
	const result = await itemModel.children(ctx.owner.id, parentName, requestPagination(ctx.query));
	return result;
});

export default router;
