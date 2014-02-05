/*jslint nomen: true */
function MessageList(table_name, filter, opts) {
    _.extend(this, {
        collapse_messages: true,
        muting_enabled: true
    }, opts);
    this.view = new MessageListView(this, table_name, this.collapse_messages);

    if (this.muting_enabled) {
        this._all_items = [];
    }
    this._items = [];
    this._hash = {};
    this.table_name = table_name;
    this.filter = filter;
    this._selected_id = -1;

    if (this.filter === undefined) {
        this.filter = new Filter();
    }

    this.narrowed = this.table_name === "zfilt";

    this.num_appends = 0;

    return this;
}

(function () {

MessageList.prototype = {
    add_messages: function MessageList_add_messages(messages, opts) {
        var self = this;
        var predicate = self.filter.predicate();
        var top_messages = [];
        var bottom_messages = [];
        var interior_messages = [];

        // If we're initially populating the list, save the messages in
        // bottom_messages regardless
        if (self.selected_id() === -1 && self.empty()) {
            var narrow_messages = _.filter(messages, predicate);
            bottom_messages = _.reject(narrow_messages, function (msg) {
                return self.get(msg.id);
            });
        } else {
            _.each(messages, function (msg) {
                // Filter out duplicates that are already in self, and all messages
                // that fail our filter predicate
                if (! (self.get(msg.id) === undefined && predicate(msg))) {
                    return;
                }

                // Put messages in correct order on either side of the message list
                if (self.empty() || msg.id > self.last().id) {
                    bottom_messages.push(msg);
                } else if (msg.id < self.first().id) {
                    top_messages.push(msg);
                } else {
                    interior_messages.push(msg);
                }
            });
        }

        if (interior_messages.length > 0) {
            self.add_and_rerender(top_messages.concat(interior_messages).concat(bottom_messages));
            return true;
        }
        if (top_messages.length > 0) {
            self.prepend(top_messages);
        }
        if (bottom_messages.length > 0) {
            self.append(bottom_messages, opts);
        }

        if ((self === narrowed_msg_list) && !self.empty() &&
            !opts.delay_render) {
            // If adding some new messages to the message tables caused
            // our current narrow to no longer be empty, hide the empty
            // feed placeholder text.
            narrow.hide_empty_narrow_message();
            // And also select the newly arrived message.
            self.select_id(self.selected_id(), {then_scroll: true, use_closest: true});
        }
    },

    get: function MessageList_get(id) {
        id = parseFloat(id);
        if (isNaN(id)) {
            return undefined;
        }
        return this._hash[id];
    },

    num_items: function MessageList_num_items() {
        return this._items.length;
    },

    empty: function MessageList_empty() {
        return this._items.length === 0;
    },

    first: function MessageList_first() {
        return this._items[0];
    },

    last: function MessageList_last() {
        return this._items[this._items.length - 1];
    },

    nth_most_recent_id: function MessageList_nth_most_recent_id(n) {
        var i = this._items.length - n;
        if (i < 0) {
            return -1;
        } else {
            return this._items[i].id;
        }
    },

    clear: function  MessageList_clear(opts) {
        opts = _.extend({clear_selected_id: true}, opts);

        if (this.muting_enabled) {
            this._all_items = [];
        }

        this._items = [];
        this._hash = {};
        this.view.clear_rendering_state(true);

        if (opts.clear_selected_id) {
            this._selected_id = -1;
        }
    },

    selected_id: function MessageList_selected_id() {
        return this._selected_id;
    },

    select_id: function MessageList_select_id(id, opts) {
        opts = _.extend({
                then_scroll: false,
                target_scroll_offset: undefined,
                use_closest: false,
                empty_ok: false,
                mark_read: true,
                force_rerender: false
            }, opts, {
                id: id,
                msg_list: this,
                previously_selected: this._selected_id
            });

        id = parseFloat(id);
        if (isNaN(id)) {
            blueslip.fatal("Bad message id");
        }

        var closest_id = this.closest_id(id);

        // The name "use_closest" option is a bit legacy.  We
        // are always gonna move to the closest visible id; the flag
        // just says whether we call blueslip.error or not.  The caller
        // sets use_closest to true when it expects us to move the
        // pointer as needed, so only generate an error if the flag is
        // false.
        if (!opts.use_closest && closest_id !== id) {
            blueslip.error("Selected message id not in MessageList",
                           {table_name: this.table_name, id: id});
        }

        if (closest_id === -1 && !opts.empty_ok) {
            var error_data = {
                table_name: this.table_name,
                id: id,
                items_length: this._items.length
            };
            blueslip.fatal("Cannot select id -1", error_data);
        }

        id = closest_id;
        opts.id = id;
        this._selected_id = id;

        if (opts.force_rerender) {
            this.rerender();
        } else if (!opts.from_rendering) {
            this.view.maybe_rerender();
        }

        $(document).trigger($.Event('message_selected.zulip', opts));
    },

    reselect_selected_id: function MessageList_select_closest_id() {
        this.select_id(this._selected_id, {from_rendering: true});
    },

    selected_message: function MessageList_selected_message() {
        return this.get(this._selected_id);
    },

    selected_row: function MessageList_selected_row() {
        return this.get_row(this._selected_id);
    },

    closest_id: function MessageList_closest_id(id) {
        var items = this._items;

        if (items.length === 0) {
            return -1;
        }

        var closest = util.lower_bound(items, id,
                                       function (a, b) {
                                           return a.id < b;
                                       });

        if (closest === items.length
            || (closest !== 0
                // We have the index at which a message with the
                // given id would be inserted, but that isn't
                // necessarily the index of the message that has an
                // id that is closest to the query; it could be the
                // previous message in the list.
                && (id - items[closest - 1].id <
                    items[closest].id - id)))
        {
            closest = closest - 1;
        }
        return items[closest].id;
    },

    advance_past_messages: function MessageList_advance_past_messages(msg_ids) {
        // Start with the current pointer, but then keep advancing the
        // pointer while the next message's id is in msg_ids.  See trac #1555
        // for more context, but basically we are skipping over contiguous
        // messages that we have recently visited.
        var next_msg_id = 0;

        var id_set = {};

        _.each(msg_ids, function (msg_id) {
            id_set[msg_id] = true;
        });

        var idx = this.selected_idx() + 1;
        while (idx < this._items.length) {
            var msg_id = this._items[idx].id;
            if (!id_set[msg_id]) {
                break;
            }
            next_msg_id = msg_id;
            ++idx;
        }

        if (next_msg_id > 0) {
            this._selected_id = next_msg_id;
        }
    },

    _add_to_hash: function MessageList__add_to_hash(messages) {
        var self = this;
        messages.forEach(function (elem) {
            var id = parseFloat(elem.id);
            if (isNaN(id)) {
                blueslip.fatal("Bad message id");
            }
            if (self._hash[id] !== undefined) {
                blueslip.error("Duplicate message added to MessageList");
                return;
            }
            self._hash[id] = elem;
        });
    },

    selected_idx: function MessageList_selected_idx() {
        return util.lower_bound(this._items, this._selected_id,
                                function (a, b) { return a.id < b; });
    },

    subscribed_bookend_content: function (stream_name) {
        return "--- Subscribed to stream " + stream_name + " ---";
    },

    unsubscribed_bookend_content: function (stream_name) {
        return "--- Unsubscribed from stream " + stream_name + " ---";
    },

    not_subscribed_bookend_content: function (stream_name) {
        return "--- Not subscribed to stream " + stream_name + " ---";
    },

    // Maintains a trailing bookend element explaining any changes in
    // your subscribed/unsubscribed status at the bottom of the
    // message list.
    update_trailing_bookend: function MessageList_update_trailing_bookend() {
        this.view.clear_trailing_bookend();
        if (!this.narrowed) {
            return;
        }
        var stream = narrow.stream();
        if (stream === undefined) {
            return;
        }
        var trailing_bookend_content, subscribed = stream_data.is_subscribed(stream);
        if (subscribed) {
            if (this.last_message_historical) {
                trailing_bookend_content = this.subscribed_bookend_content(stream);
            }
        } else {
            if (!this.last_message_historical) {
                trailing_bookend_content = this.unsubscribed_bookend_content(stream);
            } else {
                trailing_bookend_content = this.not_subscribed_bookend_content(stream);
            }
        }
        if (trailing_bookend_content !== undefined) {
            this.view.render_trailing_bookend(trailing_bookend_content);
        }
    },

    unmuted_messages: function MessageList_unmuted_messages(messages) {
        return _.reject(messages, function (message) {
            return muting.is_topic_muted(message.stream, message.subject) &&
                   !message.mentioned;
        });
    },

    append: function MessageList_append(messages, opts) {
        opts = _.extend({delay_render: false, messages_are_new: false}, opts);

        var viewable_messages;
        if (this.muting_enabled) {
            this._all_items = this._all_items.concat(messages);
            viewable_messages = this.unmuted_messages(messages);
        } else {
            viewable_messages = messages;
        }
        this._items = this._items.concat(viewable_messages);

        this.num_appends += 1;

        this._add_to_hash(messages);

        if (!opts.delay_render) {
            this.view.append(viewable_messages, opts.messages_are_new);
        }
    },

    prepend: function MessageList_prepend(messages) {
        var viewable_messages;
        if (this.muting_enabled) {
            this._all_items = messages.concat(this._all_items);
            viewable_messages = this.unmuted_messages(messages);
        } else {
            viewable_messages = messages;
        }
        this._items = viewable_messages.concat(this._items);
        this._add_to_hash(messages);
        this.view.prepend(viewable_messages);
    },

    add_and_rerender: function MessageList_add_and_rerender(messages) {
        // To add messages that might be in the interior of our
        // existing messages list, we just add the new messages and
        // then rerender the whole thing.

        var viewable_messages;
        if (this.muting_enabled) {
            this._all_items = messages.concat(this._all_items);
            this._all_items.sort(function (a, b) {return a.id - b.id;});

            viewable_messages = this.unmuted_messages(messages);
            this._items = viewable_messages.concat(this._items);

        } else {
            this._items = messages.concat(this._items);
        }

        this._items.sort(function (a, b) {return a.id - b.id;});
        this._add_to_hash(messages);

        this.view.rerender_the_whole_thing();
    },

    remove_and_rerender: function MessageList_remove_and_rerender(messages) {
        var self = this;
        _.each(messages, function (message) {
            var stored_message = self._hash[message.id];
            if (stored_message !== undefined) {
                delete self._hash[stored_message];
            }
        });

        var msg_ids_to_remove = {};
        _.each(messages, function (message) {
            msg_ids_to_remove[message.id] = true;
        });
        this._items = _.filter(this._items, function (message) {
            return !msg_ids_to_remove.hasOwnProperty(message.id);
        });
        if (this.muting_enabled) {
            this._all_items = _.filter(this._all_items, function (message) {
                return !msg_ids_to_remove.hasOwnProperty(message.id);
            });
        }

        this.view.rerender_the_whole_thing();
        this.select_id(this.selected_id(), {use_closest: true, empty_ok: true});
    },

    show_edit_message: function MessageList_show_edit_message(row, edit_obj) {
        row.find(".message_edit_form").empty().append(edit_obj.form);
        row.find(".message_content").hide();
        row.find(".message_edit").show();
        row.find(".message_edit_content").autosize();
    },

    hide_edit_message: function MessageList_hide_edit_message(row) {
        row.find(".message_content").show();
        row.find(".message_edit").hide();
    },

    show_edit_topic: function MessageList_show_edit_topic(recipient_row, form) {
        recipient_row.find(".topic_edit_form").empty().append(form);
        recipient_row.find(".stream_topic").hide();
        recipient_row.find(".topic_edit").show();
    },

    hide_edit_topic: function MessageList_hide_edit_topic(recipient_row) {
        recipient_row.find(".stream_topic").show();
        recipient_row.find(".topic_edit").hide();
    },

    show_message_as_read: function (message, options) {
        var row = this.get_row(message.id);
        if ((options.from === 'pointer' && feature_flags.mark_read_at_bottom) ||
            options.from === "server") {
            row.find('.unread_marker').addClass('fast_fade');
        } else {
            row.find('.unread_marker').addClass('slow_fade');
        }
        row.removeClass('unread');
    },

    rerender: function MessageList_rerender() {
        // We need to clear the rendering state, rather than just
        // doing clear_table, since we want to potentially recollapse
        // things.
        this._selected_id = this.closest_id(this._selected_id);
        this.view.clear_rendering_state(false);
        this.view.update_render_window(this.selected_idx(), false);
        this.view.rerender_preserving_scrolltop();
        if (this._selected_id !== -1) {
            this.select_id(this._selected_id);
        }
    },

    rerender_after_muting_changes: function MessageList_rerender_after_muting_changes() {
        if (!this.muting_enabled) {
            return;
        }

        this._items = this.unmuted_messages(this._all_items);
        this.rerender();
    },

    all: function MessageList_all() {
        return this._items;
    },

    // Returns messages from the given message list in the specified range, inclusive
    message_range: function MessageList_message_range(start, end) {
        if (start === -1) {
            blueslip.error("message_range given a start of -1");
        }

        var compare = function (a, b) { return a.id < b; };

        var start_idx = util.lower_bound(this._items, start, compare);
        var end_idx   = util.lower_bound(this._items, end,   compare);
        return this._items.slice(start_idx, end_idx + 1);
    },

    get_row: function (id) {
        return this.view.get_row(id);
    },

    change_display_recipient: function MessageList_change_display_recipient(old_recipient,
                                                                            new_recipient) {
        // This method only works for streams.
        _.each(this._items, function (item) {
            if (item.display_recipient === old_recipient) {
                item.display_recipient = new_recipient;
                item.stream = new_recipient;
            }
        });
        this.view.rerender_the_whole_thing();
    },

    change_message_id: function MessageList_change_message_id(old_id, new_id) {
        // Update our local cache that uses the old id to the new id
        function message_sort_func(a, b) {return a.id - b.id;}

        function is_local_only(message) {
            return message.id % 1 !== 0;
        }

        function next_nonlocal_message(item_list, start_index, op) {
            var cur_idx = start_index;
            do {
                cur_idx = op(cur_idx);
            } while(item_list[cur_idx] !== undefined && is_local_only(item_list[cur_idx]));
            return item_list[cur_idx];
        }

        if (this._hash.hasOwnProperty(old_id)) {
            var value = this._hash[old_id];
            delete this._hash[old_id];
            this._hash[new_id] = value;
        } else {
            return;
        }

        if (this._selected_id === old_id) {
            this._selected_id = new_id;
        }

        // If this message is now out of order, re-order and re-render
        var self = this;
        setTimeout(function () {
            var current_message = self._hash[new_id];
            var index = self._items.indexOf(current_message);

            if (index === -1) {
                if ( !self.muting_enabled && current_msg_list === self) {
                    blueslip.error("Trying to re-order message but can't find message with new_id in _items!");
                }
                return;
            }

            var next = next_nonlocal_message(self._items, index, function (idx) { return idx + 1; });
            var prev = next_nonlocal_message(self._items, index, function (idx) { return idx - 1; });

            if ((next !== undefined && current_message.id > next.id) ||
                (prev !== undefined && current_message.id < prev.id)) {
                blueslip.debug("Changed message ID from server caused out-of-order list, reordering");
                self._items.sort(message_sort_func);
                if (self.muting_enabled) {
                    self._all_items.sort(message_sort_func);
                }
                self.view.rerender_the_whole_thing();
            }
        }, 0);
    }
};

// We stop autoscrolling when the user is clearly in the middle of
// doing something.  Be careful, though, if you try to capture
// mousemove, then you will have to contend with the autoscroll
// itself generating mousemove events.
$(document).on('message_selected.zulip hashchange.zulip mousewheel', function (event) {
    viewport.stop_auto_scrolling();
});
}());
/*jslint nomen: false */
if (typeof module !== 'undefined') {
    module.exports = MessageList;
}
