defmodule Bonfire.Editor.MilkdownTest do
  use ExUnit.Case, async: true
  require Phoenix.LiveViewTest

  test "disables mentions for either representation of a message composer" do
    for type <- [:message, "message"] do
      {:ok, document} = render_editor(%{create_object_type: type}) |> Floki.parse_document()

      assert Floki.attribute(document, "#editor_milkdown_container", "data-disable-mentions") == [
               "true"
             ]
    end
  end

  defp render_editor(opts) do
    Phoenix.LiveViewTest.render_component(&Bonfire.Editor.Milkdown.render/1, %{
      __context__: %{},
      smart_input_opts: opts,
      showing_within: :page,
      field_name: "body"
    })
  end
end
