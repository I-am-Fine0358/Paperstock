const { Client } = require('@notionhq/client');

class NotionSync {
    constructor(settings, db) {
        this.settings = settings;
        this.db = db;
        this.client = null;
    }

    _getClient() {
        const token = this.settings.get('notionToken');
        if (!token) return null;
        if (!this.client) this.client = new Client({ auth: token });
        return this.client;
    }

    resetClient() {
        this.client = null;
    }

    _toUuid(id) {
        const clean = (id || '').replace(/-/g, '');
        if (clean.length !== 32) return id;
        return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20)}`;
    }

    async ensureDatabase() {
        const client = this._getClient();
        if (!client) throw new Error('Notion APIトークンが設定されていません');

        const rawPageId = this.settings.get('notionPageId');
        if (!rawPageId) throw new Error('Notion 読書ログページIDが設定されていません');
        const pageId = this._toUuid(rawPageId);

        let dbId = this.settings.get('notionDatabaseId');

        if (dbId) {
            try {
                await client.databases.retrieve({ database_id: this._toUuid(dbId) });
                return this._toUuid(dbId);
            } catch (e) {
                this.settings.set('notionDatabaseId', '');
                dbId = '';
            }
        }

        // Create inline database under the reading log page
        const response = await client.databases.create({
            parent: { type: 'page_id', page_id: pageId },
            is_inline: true,
            title: [{ type: 'text', text: { content: '読書記録' } }],
        });

        dbId = response.id;
        this.settings.set('notionDatabaseId', dbId);
        return dbId;
    }

    async syncBook(book, comments) {
        if (!this.settings.get('notionSyncEnabled')) return;
        const client = this._getClient();
        if (!client) return;

        try {
            const dbId = await this.ensureDatabase();

            // Use stored notion_page_id first, then search by title
            let existingPageId = book.notion_page_id || null;
            if (existingPageId) {
                try { await client.pages.retrieve({ page_id: existingPageId }); }
                catch (e) { existingPageId = null; }
            }
            if (!existingPageId) {
                existingPageId = await this._findBookPage(dbId, book.title);
            }

            const statusMap = { unread: '未読', reading: '読書中', completed: '読了' };

            const properties = {
                title: { title: [{ text: { content: book.title } }] },
            };

            // Build comment blocks
            const commentBlocks = [];
            if (comments && comments.length > 0) {
                commentBlocks.push({
                    object: 'block',
                    type: 'heading_3',
                    heading_3: { rich_text: [{ type: 'text', text: { content: 'コメント（Paperstockから同期）' } }] }
                });
                // Group by page
                const byPage = {};
                for (const c of comments) {
                    if (!byPage[c.page_num]) byPage[c.page_num] = [];
                    byPage[c.page_num].push(c);
                }
                for (const [pageNum, pageComments] of Object.entries(byPage)) {
                    commentBlocks.push({
                        object: 'block',
                        type: 'paragraph',
                        paragraph: { rich_text: [{ type: 'text', text: { content: `P.${pageNum}` }, annotations: { bold: true } }] }
                    });
                    for (const c of pageComments) {
                        if (c.content) {
                            commentBlocks.push({
                                object: 'block',
                                type: 'bulleted_list_item',
                                bulleted_list_item: { rich_text: [{ type: 'text', text: { content: c.content } }] }
                            });
                        }
                    }
                }
            }

            const bodyBlocks = [
                {
                    object: 'block',
                    type: 'callout',
                    callout: {
                        icon: { type: 'emoji', emoji: '📗' },
                        rich_text: [{ type: 'text', text: { content: `Paperstock ID: ${book.id}` } }],
                    }
                },
                {
                    object: 'block',
                    type: 'table',
                    table: {
                        table_width: 2,
                        has_column_header: false,
                        has_row_header: true,
                        children: [
                            this._tableRow('ステータス', statusMap[book.status] || '未読'),
                            this._tableRow('ページ数', String(book.page_count || 0)),
                            this._tableRow('タグ', (book.tags || []).map(t => t.name).join(', ') || 'なし'),
                            this._tableRow('お気に入り', book.favorite ? '★' : '-'),
                            this._tableRow('追加日', book.created_at ? book.created_at.split(' ')[0] : '-'),
                            this._tableRow('最終閲覧日', book.last_opened_at ? book.last_opened_at.split('T')[0] : '-'),
                        ]
                    }
                },
                ...commentBlocks,
                {
                    object: 'block',
                    type: 'heading_2',
                    heading_2: { rich_text: [{ type: 'text', text: { content: 'メモ' } }] }
                },
                {
                    object: 'block',
                    type: 'paragraph',
                    paragraph: { rich_text: [] }
                },
            ];

            if (existingPageId) {
                await client.pages.update({ page_id: existingPageId, properties });
                // Delete managed blocks (callout, table, comment heading) and recreate
                try {
                    const oldBlocks = await client.blocks.children.list({ block_id: existingPageId, page_size: 50 });
                    for (const block of oldBlocks.results) {
                        if (block.type === 'callout' || block.type === 'table' ||
                            block.type === 'heading_3' || block.type === 'bulleted_list_item' ||
                            (block.type === 'paragraph' && block.paragraph?.rich_text?.[0]?.annotations?.bold)) {
                            await client.blocks.delete({ block_id: block.id });
                        }
                    }
                    await client.blocks.children.append({
                        block_id: existingPageId,
                        children: bodyBlocks.slice(0, 2 + commentBlocks.length),
                    });
                } catch (e) { /* title update still succeeded */ }

                // Store notion_page_id if not already stored
                if (!book.notion_page_id) {
                    this.db.updateBook(book.id, { notionPageId: existingPageId });
                }
            } else {
                const newPage = await client.pages.create({
                    parent: { type: 'database_id', database_id: dbId },
                    properties,
                    children: bodyBlocks,
                });
                // Store notion_page_id
                this.db.updateBook(book.id, { notionPageId: newPage.id });
            }
        } catch (e) {
            console.error('Notion sync failed:', e.message);
            throw e;
        }
    }

    _tableRow(label, value) {
        return {
            type: 'table_row',
            table_row: {
                cells: [
                    [{ type: 'text', text: { content: label } }],
                    [{ type: 'text', text: { content: value } }],
                ]
            }
        };
    }

    async syncAllBooks() {
        if (!this.settings.get('notionSyncEnabled')) return { synced: 0, errors: 0 };
        const client = this._getClient();
        if (!client) throw new Error('Notion APIトークンが設定されていません');

        await this.ensureDatabase();
        const books = this.db.getAllBooks();
        let synced = 0, errors = 0;

        for (const book of books) {
            try {
                const comments = this.db.getCommentsForBook(book.id);
                await this.syncBook(book, comments);
                synced++;
            } catch (e) {
                console.error(`Sync error for "${book.title}":`, e.message);
                errors++;
            }
        }

        return { synced, errors };
    }

    async _findBookPage(dbId, title) {
        const client = this._getClient();
        if (!client) return null;

        try {
            const response = await client.databases.query({
                database_id: dbId,
                filter: {
                    property: 'title',
                    title: { equals: title },
                },
                page_size: 1,
            });

            if (response.results.length > 0) {
                return response.results[0].id;
            }
        } catch (e) {
            // Fallback: scan all pages
            try {
                const response = await client.databases.query({ database_id: dbId, page_size: 100 });
                for (const page of response.results) {
                    const pageTitle = page.properties?.title?.title?.[0]?.plain_text ||
                                     page.properties?.['書籍名']?.title?.[0]?.plain_text || '';
                    if (pageTitle === title) return page.id;
                }
            } catch (e2) { /* give up */ }
        }

        return null;
    }

    async testConnection() {
        const client = this._getClient();
        if (!client) throw new Error('APIトークンが未設定です');

        const rawPageId = this.settings.get('notionPageId');
        if (!rawPageId) throw new Error('ページIDが未設定です');

        const page = await client.pages.retrieve({ page_id: this._toUuid(rawPageId) });
        return { success: true, title: 'OK' };
    }
}

module.exports = NotionSync;
